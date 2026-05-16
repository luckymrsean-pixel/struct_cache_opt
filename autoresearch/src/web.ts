/**
 * src/web.ts — WebSocket 服务端
 *
 * 启动方式（在 runLoop 启动前调用）：
 *   startWebServer(cfg, cli, loopTerm, 8080)
 *
 * 协议（JSON 帧）：
 *   server → client:
 *     { type:"status",            iter, total, phase, best, alive, stages } 每 2s 推
 *     { type:"git",               branch, lastCommit, changed:string[] }    每 2s 推
 *     { type:"log",               files: LogFile[] }                        每 2s 推
 *     { type:"history",           commits, head }                           每 2s 推 + 握手
 *     { type:"skill-state",       ...SkillState }                           每 2s 推 + 握手
 *     { type:"stage-log-updated", stage:number }                            fs.watch 触发
 *     { type:"toast",             msg:string }                              一次性
 *
 *   client → server:
 *     { type:"config", dryRun:boolean }
 *     { type:"loop",   action:"start"|"stop", iterations? }
 *     { type:"apply",  hash:string }
 */

import * as http from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { WebSocket, WebSocketServer } from "ws";
import { InteractivePty } from "./interactive-pty";
import { Terminal } from "./terminal";
import { bestSoFar } from "./logger";
import { Config } from "./config";
import { runtime } from "./loop";
import { watch } from "fs";
import { stageLogPath } from "./stage_log";
import { getSkillState, getSkillDiff, getSkillShow } from "./skill_state";
import { parseMetaState, getMetaRun } from "./meta_state";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusMsg {
  type:       "status";
  iter:       number;
  total:      number;
  phase:      string;
  best:       number | null;
  alive:      boolean;
  stages:     Record<number, string>;
}

interface GitMsg {
  type:       "git";
  branch:     string;
  lastCommit: string;
  changed:    string[];
}

interface LogFile {
  label: string;
  path:  string;
  size:  string;
  exists: boolean;
}

interface LogMsg {
  type:  "log";
  files: LogFile[];
}

// ─── State shared with loop.ts ────────────────────────────────────────────────

export interface LoopState {
  iter:   number;
  phase:  string;
  // Per-stage UI state, keyed by the stage id used in Dashboard.html.
  // 0=Init, 1=Ideate, 2=Apply, 3=Build, 4=Verify, 5=Commit/Decide, 6=Schedule.
  // Values: "idle" | "running" | "done" | "error" | "confirm".
  stages: Record<number, string>;
}

export const loopState: LoopState = {
  iter:   0,
  phase:  "idle",
  stages: { 0: "confirm", 1: "idle", 2: "idle", 3: "idle", 4: "idle", 5: "idle", 6: "idle" },
};

/**
 * Helpers for loop.ts to mark stage transitions. Resets the per-iter stages
 * (1-6) to idle at the start of an iter; Stage 0 (init) flips to "done"
 * the first time setup completes and stays there.
 */
export function setStage(id: number, status: string): void {
  loopState.stages[id] = status;
}
export function resetIterStages(): void {
  for (let i = 1; i <= 6; i++) loopState.stages[i] = "idle";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function broadcast(wss: WebSocketServer, msg: object): void {
  const s = JSON.stringify(msg);
  let n = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) { client.send(s); n++; }
  }
  // Only log "interesting" broadcasts. Routine ones (the 2-sec
  // status/git/log/history/skill-state pulses) would drown out the per-stage
  // [iter N] lines we actually care about. Keep: toast, stage-log-updated,
  // anything novel.
  const t = (msg as { type?: string }).type;
  const ROUTINE = new Set(["status", "git", "log", "history", "skill-state"]);
  if (t && !ROUTINE.has(t)) {
    console.error(`[web] broadcast type=${t} → ${n} client(s)`);
  }
}


function getGitStatus(workdir: string): GitMsg {
  const run = (cmd: string) => {
    try { return execSync(cmd, { cwd: workdir, encoding: "utf8" }).trim(); }
    catch { return ""; }
  };
  return {
    type:       "git",
    branch:     run("git rev-parse --abbrev-ref HEAD") || "unknown",
    lastCommit: run("git log -1 --pretty=%s") || "(no commits)",
    changed:    run("git diff --name-only HEAD").split("\n").filter(Boolean),
  };
}

interface CommitInfo {
  hash:    string;
  iter:    number;
  subject: string;
  date:    string;
  status:  string;
  metric:  number | null;
  delta:   number | null;
  files:   string[];
  isCurrent: boolean;
}

interface HistoryMsg {
  type:    "history";
  commits: CommitInfo[];
  head:    string;
}

function parseTsvMap(tsvPath: string): Map<number, { status: string; metric: number | null; delta: number | null }> {
  const map = new Map();
  if (!existsSync(tsvPath)) return map;
  for (const line of readFileSync(tsvPath, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("iter")) continue;
    const [iter, status, metric, delta] = line.split("\t");
    map.set(Number(iter), {
      status,
      metric: metric ? Number(metric) : null,
      delta:  delta  ? Number(delta)  : null,
    });
  }
  return map;
}

function getHistory(cfg: Config): HistoryMsg {
  const run = (cmd: string) => {
    try { return execSync(cmd, { cwd: cfg.workdir, encoding: "utf8" }).trim(); }
    catch { return ""; }
  };

  const tsv   = parseTsvMap(cfg.tsvPath);
  const head  = run("git rev-parse HEAD").slice(0, 7);

  // Get all experiment: commits + baseline
  const log = run(
    `git log --pretty=format:'%h|||%s|||%ad' --date=short -- .`
  );

  const commits: CommitInfo[] = log.split("\n")
    .filter(Boolean)
    .map((line): CommitInfo | null => {
      const [hash, subject, date] = line.split("|||");
      const iterMatch = subject.match(/experiment:\s*iter\s*(\d+)/i);
      const isBaseline = /baseline/i.test(subject);
      const iter = iterMatch ? Number(iterMatch[1]) : (isBaseline ? 0 : -1);
      if (iter < 0) return null;

      const tsvRow = tsv.get(iter);
      const files = run(
        `git diff-tree --no-commit-id -r --name-only ${hash}`
      ).split("\n").filter(Boolean);

      return {
        hash:      hash.trim(),
        iter,
        subject:   subject.trim(),
        date:      date?.trim() ?? "",
        status:    tsvRow?.status ?? (isBaseline ? "baseline" : "unknown"),
        metric:    tsvRow?.metric ?? null,
        delta:     tsvRow?.delta  ?? null,
        files,
        isCurrent: hash.trim().startsWith(head),
      };
    })
    .filter((c): c is CommitInfo => c !== null);

  return { type: "history", commits, head };
}

function getLogFiles(cfg: Config): LogMsg {
  const files: LogFile[] = [
    { label: "results.tsv",  path: cfg.tsvPath,                  size: "", exists: false },
    { label: "loop.log",     path: join(cfg.workdir, "loop.log"), size: "", exists: false },
    { label: ".ar.patch",    path: join(cfg.workdir, ".ar.patch"),size: "", exists: false },
    { label: "build.log",    path: join(cfg.workdir, "build.log"),size: "", exists: false },
  ];
  for (const f of files) {
    f.exists = existsSync(f.path);
    if (f.exists) {
      const bytes = statSync(f.path).size;
      f.size = bytes < 1024 ? `${bytes} B`
             : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB`
             : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    }
  }
  return { type: "log", files };
}

// ─── startWebServer ───────────────────────────────────────────────────────────

export function startWebServer(
  cfg:      Config,
  cli:      InteractivePty,
  loopTerm: Terminal,
  port = 8080,
): void {
  // Serve dashboard HTML — try a few candidate locations because the file may
  // sit either in the autoresearch dir (legacy) or at the parent project root
  // (where it currently lives in this repo).
  const dashCandidates = [
    join(__dirname, "..", "Autoresearch Dashboard.html"),         // autoresearch/
    join(__dirname, "..", "..", "Autoresearch Dashboard.html"),   // project root
    join(process.cwd(), "Autoresearch Dashboard.html"),
    join(process.cwd(), "..", "Autoresearch Dashboard.html"),
  ];
  const dashPath = dashCandidates.find((p) => existsSync(p)) ?? dashCandidates[0];

  // Meta-loop sources: project root holds meta_results.tsv + meta-runs/ +
  // meta-driver.pid; the skill git repo (where the `champion` tag lives) is
  // the parent of cfg.skillDir (…/target_skill/struct_layout_opt → …/target_skill).
  const metaRootCandidates = [
    join(__dirname, "..", ".."),       // project root (where this repo lives)
    process.cwd(),
  ];
  const cacheRoot =
    metaRootCandidates.find((p) => existsSync(join(p, "meta_results.tsv"))) ??
    metaRootCandidates[0];
  const skillRepo = cfg.skillDir ? dirname(cfg.skillDir) : "";

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    // Per-stage log for the bottom dashboard panel. Reads .ar/stage-N.log
    // written by loop.ts; caps response at 1 MB.
    {
      const m = url.match(/^\/api\/stage-log\?stage=(\d+)/);
      if (m) {
        const stage = Number(m[1]);
        const p     = stageLogPath(cfg.workdir, stage);
        if (!existsSync(p)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`stage-${stage}.log not yet written`);
          return;
        }
        let body = readFileSync(p, "utf8");
        const CAP = 1024 * 1024;
        if (body.length > CAP) {
          body = `[truncated — last ${CAP} bytes of ${body.length}]\n` + body.slice(-CAP);
        }
        res.writeHead(200, {
          "Content-Type":  "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }
    }

    // Skill manifest + diff-vs-champion summary (top-center quadrants).
    if (url === "/api/skill-state") {
      if (!cfg.skillDir) { res.writeHead(404); res.end("skillDir not configured"); return; }
      const state = getSkillState(cfg.skillDir);
      res.writeHead(200, {
        "Content-Type":  "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(state));
      return;
    }

    // Unified diff for one evolving file vs champion (drives diff modal).
    {
      const m = url.match(/^\/api\/skill-diff\?path=([^&]+)/);
      if (m) {
        if (!cfg.skillDir) { res.writeHead(404); res.end("skillDir not configured"); return; }
        const path = decodeURIComponent(m[1]);
        const body = getSkillDiff(cfg.skillDir, path);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(body || `(no diff for ${path})`);
        return;
      }
    }

    // File contents at the champion ref (drives winner modal).
    {
      const m = url.match(/^\/api\/skill-show\?ref=([^&]+)&path=([^&]+)/);
      if (m) {
        if (!cfg.skillDir) { res.writeHead(404); res.end("skillDir not configured"); return; }
        const ref  = decodeURIComponent(m[1]);
        const path = decodeURIComponent(m[2]);
        const body = getSkillShow(cfg.skillDir, ref, path);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(body || `(no content at ${ref}:${path})`);
        return;
      }
    }

    // REST polling endpoint — returns everything the dashboard needs in one
    // JSON payload, so the UI can stay live even when the WebSocket Upgrade
    // is blocked (corporate proxy, VS Code Simple Browser, etc.).
    if (url === "/api/state") {
      const payload = {
        status: {
          type:   "status",
          iter:   loopState.iter,
          total:  cfg.iterations,
          phase:  loopState.phase,
          best:   bestSoFar(cfg.tsvPath, cfg.direction),
          alive:  cli.alive && loopTerm.alive,
          stages: { ...loopState.stages },
        },
        git:     getGitStatus(cfg.workdir),
        logs:    getLogFiles(cfg),
        history: getHistory(cfg),
      };
      res.writeHead(200, {
        "Content-Type":  "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url === "/meta-versions.html") {
      const candidates = [
        join(__dirname, "..", "..", "meta-versions.html"),
        join(process.cwd(), "meta-versions.html"),
        join(process.cwd(), "..", "meta-versions.html"),
      ];
      const p = candidates.find((x) => existsSync(x));
      if (p) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(p));
      } else {
        res.writeHead(404); res.end("meta-versions.html not found");
      }
      return;
    }

    if (url.startsWith("/meta_results.tsv")) {
      const candidates = [
        join(__dirname, "..", "..", "meta_results.tsv"),
        join(process.cwd(), "meta_results.tsv"),
        join(process.cwd(), "..", "meta_results.tsv"),
      ];
      const p = candidates.find((x) => existsSync(x));
      if (p) {
        res.writeHead(200, { "Content-Type": "text/tab-separated-values" });
        res.end(readFileSync(p));
      } else {
        res.writeHead(404); res.end("meta_results.tsv not found");
      }
      return;
    }

    if (url === "/api/meta-state") {
      res.writeHead(200, {
        "Content-Type":  "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(parseMetaState(cacheRoot, skillRepo)));
      return;
    }

    if (url.startsWith("/api/meta-run")) {
      const tag = new URL(url, "http://x").searchParams.get("tag") ?? "";
      const detail = getMetaRun(cacheRoot, tag);
      if (!detail) { res.writeHead(404); res.end("unknown meta run"); return; }
      res.writeHead(200, {
        "Content-Type":  "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(detail));
      return;
    }

    if (existsSync(dashPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(dashPath));
    } else {
      res.writeHead(404);
      res.end(
        "Dashboard HTML not found. Tried:\n  " + dashCandidates.join("\n  "),
      );
    }
  });

  const wss = new WebSocketServer({ server });

  // Watch .ar/stage-*.log for changes; notify clients to re-fetch via REST.
  for (let i = 0; i <= 6; i++) {
    const p = stageLogPath(cfg.workdir, i);
    // fs.watch fires even for files that don't yet exist on some platforms;
    // on Linux it errors with ENOENT. Tolerate by attempting later: re-arm
    // every 5 s for stages whose log file does not yet exist OR if watch()
    // itself throws (e.g. TOCTOU: file vanishes between existsSync and watch).
    const armWatcher = () => {
      if (!existsSync(p)) {
        setTimeout(armWatcher, 5000);
        return;
      }
      try {
        watch(p, { persistent: false }, () => {
          broadcast(wss, { type: "stage-log-updated", stage: i });
        });
      } catch (e) {
        console.error(`[stage-log] watch ${i} failed:`, e);
        setTimeout(armWatcher, 5000);
      }
    };
    armWatcher();
  }

  // Watch the meta-loop lineage + driver heartbeat; notify clients to re-pull
  // /api/meta-state (same pull-on-notify pattern as the stage-log panel).
  for (const rel of ["meta_results.tsv", join("meta-runs", "driver.log")]) {
    const p = join(cacheRoot, rel);
    const armMeta = () => {
      if (!existsSync(p)) { setTimeout(armMeta, 5000); return; }
      try {
        watch(p, { persistent: false }, () => {
          broadcast(wss, { type: "meta-updated" });
        });
      } catch (e) {
        console.error(`[meta-state] watch ${rel} failed:`, e);
        setTimeout(armMeta, 5000);
      }
    };
    armMeta();
  }

  wss.on("connection", (ws: WebSocket, req) => {
    const peer = req.socket.remoteAddress ?? "?";
    console.error(`[web] WS connect from ${peer} (clients=${wss.clients.size})`);
    ws.on("close", (code: number) => {
      console.error(`[web] WS close ${peer} code=${code} (clients=${wss.clients.size})`);
    });
    ws.on("error", (e: Error) => {
      console.error(`[web] WS error ${peer}: ${e.message}`);
    });

    // Send current state on connect
    ws.send(JSON.stringify({
      type:  "status",
      iter:   loopState.iter,
      total:  cfg.iterations,
      phase:  loopState.phase,
      best:   bestSoFar(cfg.tsvPath, cfg.direction),
      alive:  cli.alive && loopTerm.alive,
      stages: { ...loopState.stages },
    } satisfies StatusMsg));
    ws.send(JSON.stringify(getGitStatus(cfg.workdir)));
    ws.send(JSON.stringify(getLogFiles(cfg)));
    ws.send(JSON.stringify(getHistory(cfg)));
    ws.send(JSON.stringify({ type: "skill-state", ...getSkillState(cfg.skillDir) }));
    ws.send(JSON.stringify(parseMetaState(cacheRoot, skillRepo)));

    ws.on("message", async (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());

        if (m.type === "config" && typeof m.dryRun === "boolean") {
          runtime.dryRun = m.dryRun;
          console.error(`[web] dryRun = ${runtime.dryRun}`);
          broadcast(wss, { type: "toast", msg: `Dry Run ${runtime.dryRun ? "ON" : "OFF"}` });
        }
        if (m.type === "loop" && m.action === "start") {
          // Iteration count override from the dashboard's "× <N>" input.
          // undefined = use cfg.iterations.
          runtime.iterationsOverride =
            typeof m.iterations === "number" && m.iterations > 0
              ? m.iterations
              : undefined;
          runtime.signalStart();
          broadcast(wss, { type: "toast", msg: `Loop started (×${runtime.iterationsOverride ?? "cfg"})` });
        }
        if (m.type === "loop" && m.action === "stop") {
          runtime.stopRequested = true;
          broadcast(wss, { type: "toast", msg: "Stop requested — will exit after current iter" });
        }
        if (m.type === "apply" && /^[0-9a-f]{4,40}$/.test(m.hash)) {
          // Reset working tree to the chosen commit
          execSync(`git reset --hard ${m.hash}`, { cwd: cfg.workdir });
          console.error(`[web] applied ${m.hash}`);
          // Broadcast updated state immediately
          broadcast(wss, getGitStatus(cfg.workdir));
          broadcast(wss, getHistory(cfg));
          broadcast(wss, {
            type: "toast",
            msg:  `Applied ${m.hash} — restart loop to iterate from here`,
          });
        }
      } catch (e) { console.error("[web] ws message error:", e); }
    });
  });

  // Periodic status push every 2 s
  setInterval(() => {
    broadcast(wss, {
      type:  "status",
      iter:   loopState.iter,
      total:  cfg.iterations,
      phase:  loopState.phase,
      best:   bestSoFar(cfg.tsvPath, cfg.direction),
      alive:  cli.alive && loopTerm.alive,
      stages: { ...loopState.stages },
    } satisfies StatusMsg);
    broadcast(wss, getGitStatus(cfg.workdir));
    broadcast(wss, getLogFiles(cfg));
    broadcast(wss, getHistory(cfg));
    broadcast(wss, { type: "skill-state", ...getSkillState(cfg.skillDir) });
    broadcast(wss, parseMetaState(cacheRoot, skillRepo));
  }, 2000);

  server.listen(port, () => {
    console.error(`[web] Dashboard → http://localhost:${port}`);
  });
}
