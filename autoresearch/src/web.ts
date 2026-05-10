/**
 * src/web.ts — WebSocket 服务端
 *
 * 启动方式（在 runLoop 启动前调用）：
 *   startWebServer(cfg, main, cli, 8080)
 *
 * 两个 InteractivePty 给用户交互（main / cli），loop 跑在隐藏的 Terminal
 * 实例（不广播）。所有用户帧都带 `term: "main"|"cli"`。
 *
 * 协议（JSON 帧）：
 *   server → client:
 *     { type:"pty",                  term, data:string }      原始 PTY 字节
 *     { type:"dead",                 term, code, signal }      PTY 异常退出
 *     { type:"restarted",            term }                   重启完成
 *     { type:"restart-failed",       term, reason:string }    重启失败
 *     { type:"restart-check-result", term, hasChildren, childCmds:string[] }
 *     { type:"status",  iter, total, phase, best, alive }     alive = main && cli
 *     { type:"git",     branch, lastCommit, changed:string[] }
 *     { type:"log",     files: LogFile[] }
 *     { type:"history", commits, head }
 *     { type:"toast",   msg:string }
 *
 *   client → server:
 *     { type:"input",         term, data:string }
 *     { type:"resize",        term, cols, rows }
 *     { type:"restart-check", term }                          查询有无子进程
 *     { type:"restart",       term }                          执行重启
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
  iter:  number;
  phase: string;
}

export const loopState: LoopState = { iter: 0, phase: "idle" };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function broadcast(wss: WebSocketServer, msg: object): void {
  const s = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(s);
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
  cfg:   Config,
  main:  InteractivePty,
  cli:   InteractivePty,
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

  const server = http.createServer((_req, res) => {
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

  // Forward raw PTY bytes & lifecycle events for both terminals.
  for (const [name, t] of [["main", main], ["cli", cli]] as const) {
    t.on("data", (d: string) => {
      broadcast(wss, { type: "pty", term: name, data: d });
    });
    t.on("dead", (info: { code: number | null; signal: number | null }) => {
      broadcast(wss, { type: "dead", term: name, code: info.code, signal: info.signal });
    });
    t.on("restarted", () => {
      broadcast(wss, { type: "restarted", term: name });
    });
    t.on("restart-failed", (info: { reason: string }) => {
      broadcast(wss, { type: "restart-failed", term: name, reason: info.reason });
    });
  }

  wss.on("connection", (ws: WebSocket) => {
    // Send current state on connect
    ws.send(JSON.stringify({
      type:  "status",
      iter:  loopState.iter,
      total: cfg.iterations,
      phase: loopState.phase,
      best:  bestSoFar(cfg.tsvPath, cfg.direction),
      alive: main.alive && cli.alive,
    } satisfies StatusMsg));
    ws.send(JSON.stringify(getGitStatus(cfg.workdir)));
    ws.send(JSON.stringify(getLogFiles(cfg)));

    // Keyboard input → PTY; apply → git reset --hard
    ws.on("message", async (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        const target = m.term === "cli" ? cli : main;

        if (m.type === "input"  && (m.term === "main" || m.term === "cli")) {
          target.write(m.data);
        }
        if (m.type === "resize" && (m.term === "main" || m.term === "cli")) {
          target.resize(m.cols, m.rows);
        }
        if (m.type === "restart-check" && (m.term === "main" || m.term === "cli")) {
          const kids = await target.getChildren();
          ws.send(JSON.stringify({
            type: "restart-check-result",
            term: m.term,
            hasChildren: kids.length > 0,
            childCmds:   kids.map((k) => k.cmd),
          }));
        }
        if (m.type === "restart" && (m.term === "main" || m.term === "cli")) {
          await target.restart();
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
      iter:  loopState.iter,
      total: cfg.iterations,
      phase: loopState.phase,
      best:  bestSoFar(cfg.tsvPath, cfg.direction),
      alive: main.alive && cli.alive,
    } satisfies StatusMsg);
    broadcast(wss, getGitStatus(cfg.workdir));
    broadcast(wss, getLogFiles(cfg));
    broadcast(wss, getHistory(cfg));
  }, 2000);

  server.listen(port, () => {
    console.error(`[web] Dashboard → http://localhost:${port}`);
  });
}
