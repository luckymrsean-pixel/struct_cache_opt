/**
 * src/web.ts — WebSocket 服务端
 *
 * 启动方式（在 runLoop 启动前调用）：
 *   startWebServer(cfg, cli, loopTerm, 8080)
 *
 * Wire term 名:
 *   - "main" : 自动循环 PTY (loopTerm) 的只读镜像 — 在 dashboard 顶部面板
 *              展示 ideate / apply / build / verify 输出
 *   - "cli"  : 用户可输入的 InteractivePty (claude login / 调试)
 *
 * 服务端只接受 term==="cli" 的 input / resize / restart-* 帧;
 * term==="main" 的同类帧会被忽略 (loopTerm 由 runLoop 拥有)。
 *
 * 协议（JSON 帧）：
 *   server → client:
 *     { type:"pty",                  term, data:string }      原始 PTY 字节
 *     { type:"dead",                 term, code, signal }      PTY 异常退出
 *     { type:"restarted",            term }                   重启完成
 *     { type:"restart-failed",       term, reason:string }    重启失败
 *     { type:"restart-check-result", term, hasChildren, childCmds:string[] }
 *     { type:"status",  iter, total, phase, best, alive }     alive = cli && loopTerm
 *     { type:"git",     branch, lastCommit, changed:string[] }
 *     { type:"log",     files: LogFile[] }
 *     { type:"history", commits, head }
 *     { type:"toast",   msg:string }
 *
 *   client → server (只对 term==="cli" 有效):
 *     { type:"input",         term:"cli", data:string }
 *     { type:"resize",        term:"cli", cols, rows }
 *     { type:"restart-check", term:"cli" }                    查询有无子进程
 *     { type:"restart",       term:"cli" }                    执行重启
 *     { type:"config",  dryRun:boolean }
 *     { type:"loop",    action:"start"|"stop", iterations? }
 *     { type:"apply",   hash:string }
 */

import * as http from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { WebSocket, WebSocketServer } from "ws";
import { InteractivePty } from "./interactive-pty";
import { Terminal } from "./terminal";
import { bestSoFar } from "./logger";
import { Config } from "./config";
import { runtime } from "./loop";

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
  // Only log "interesting" broadcasts. Routine ones (pty bytes, the 2-sec
  // status/git/log/history pulses) would drown out the per-stage [iter N]
  // lines we actually care about. Keep: toast, dead, restarted,
  // restart-failed, restart-check-result, anything novel.
  const t = (msg as { type?: string }).type;
  const ROUTINE = new Set(["pty", "status", "git", "log", "history"]);
  if (t && !ROUTINE.has(t)) {
    console.error(`[web] broadcast type=${t} → ${n} client(s)`);
  }
}

// PTY ring buffers: keep the last N bytes per terminal so a polling client
// (no WebSocket) can fetch a full snapshot via /api/state.
// PTY ring buffers: keep the last N bytes per terminal so a polling client
// (no WebSocket) can fetch a full snapshot via /api/state.
//
// Wire term names:
//   - "main" carries loopTerm bytes (read-only mirror of automation PTY)
//   - "cli"  is the user-interactive PTY (claude login, debug, …)
const PTY_BUF_BYTES = 64 * 1024;
const ptyBuf: Record<"main" | "cli", string> = { main: "", cli: "" };
function ptyAppend(name: "main" | "cli", d: string): void {
  ptyBuf[name] = (ptyBuf[name] + d).slice(-PTY_BUF_BYTES);
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

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

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
        pty:     { main: ptyBuf.main, cli: ptyBuf.cli },
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

  // Forward raw PTY bytes & lifecycle events for the interactive cli pane.
  cli.on("data", (d: string) => {
    ptyAppend("cli", d);
    broadcast(wss, { type: "pty", term: "cli", data: d });
  });
  cli.on("dead", (info: { code: number | null; signal: number | null }) => {
    broadcast(wss, { type: "dead", term: "cli", code: info.code, signal: info.signal });
  });
  cli.on("restarted", () => {
    broadcast(wss, { type: "restarted", term: "cli" });
  });
  cli.on("restart-failed", (info: { reason: string }) => {
    broadcast(wss, { type: "restart-failed", term: "cli", reason: info.reason });
  });

  // Lifecycle for the loop's automation PTY → flag "main" pane as dead if
  // it ever exits. Bytes themselves arrive via the stderr mirror below
  // (loopTerm already writes its bytes to process.stderr).
  loopTerm.on("dead", () => {
    broadcast(wss, { type: "dead", term: "main", code: null, signal: null });
  });

  // Mirror everything that goes to process.stderr (loopTerm PTY bytes,
  // console.error lines from loop.ts / web.ts, anything else) into the
  // "main" pane of the dashboard. This makes the dashboard's top pane a
  // live, read-only view of loop.log without needing a separate tail.
  //
  // Safety: `pty` is in the ROUTINE broadcast set so the call below does
  // NOT itself emit a console.error → no recursion.
  const origStderrWrite = process.stderr.write.bind(process.stderr) as (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ) => boolean;
  type WriteFn = typeof process.stderr.write;
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    try {
      const s = typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      ptyAppend("main", s);
      broadcast(wss, { type: "pty", term: "main", data: s });
    } catch { /* never break stderr because of mirror failure */ }
    return origStderrWrite(chunk, encoding as BufferEncoding, cb);
  }) as WriteFn;

  wss.on("connection", (ws: WebSocket, req) => {
    const peer = req.socket.remoteAddress ?? "?";
    console.error(`[web] WS connect from ${peer} (clients=${wss.clients.size})`);
    ws.on("close", (code: number) => {
      console.error(`[web] WS close ${peer} code=${code} (clients=${wss.clients.size})`);
    });
    ws.on("error", (e: Error) => {
      console.error(`[web] WS error ${peer}: ${e.message}`);
    });

    // Replay the PTY ring buffers so a fresh client sees terminal history,
    // not just events from this point forward.
    if (ptyBuf.main) ws.send(JSON.stringify({ type: "pty", term: "main", data: ptyBuf.main }));
    if (ptyBuf.cli)  ws.send(JSON.stringify({ type: "pty", term: "cli",  data: ptyBuf.cli  }));

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

    // Only the cli pane accepts keystrokes / resize / restart from the
    // dashboard. The "main" pane is a read-only mirror of loopTerm.
    ws.on("message", async (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());

        if (m.type === "input"  && m.term === "cli") {
          cli.write(m.data);
        }
        if (m.type === "resize" && m.term === "cli") {
          cli.resize(m.cols, m.rows);
        }
        if (m.type === "restart-check" && m.term === "cli") {
          const kids = await cli.getChildren();
          ws.send(JSON.stringify({
            type: "restart-check-result",
            term: m.term,
            hasChildren: kids.length > 0,
            childCmds:   kids.map((k) => k.cmd),
          }));
        }
        if (m.type === "restart" && m.term === "cli") {
          await cli.restart();
        }
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
  }, 2000);

  server.listen(port, () => {
    console.error(`[web] Dashboard → http://localhost:${port}`);
  });
}
