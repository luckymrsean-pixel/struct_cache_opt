# Dual Interactive Terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire two always-interactive PTYs (`main`, `cli`) into the dashboard, isolated from the loop's automation PTY, with restart buttons and robust WebSocket reconnect.

**Architecture:** Three PTYs total. Two are user-interactive (`InteractivePty` instances) and broadcast their bytes to xterm.js via WebSocket. The third is the existing `Terminal` instance owned by `runLoop`; it never broadcasts. The dashboard sends `{type:"input", term, data}` for keystrokes, `{type:"restart-check"}` then `{type:"restart"}` for the per-terminal ↻ button. WebSocket disconnects retry with exponential backoff before falling back to demo mode.

**Tech Stack:** Node.js, TypeScript, `node-pty`, `ws`, vanilla HTML + xterm.js. Tests are bare TypeScript scripts run via `tsx` (no jest/vitest), following the pattern in [autoresearch/scripts/test-term.ts](../../../autoresearch/scripts/test-term.ts).

**Spec:** [docs/superpowers/specs/2026-05-10-dual-interactive-terminals-design.md](../specs/2026-05-10-dual-interactive-terminals-design.md)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `autoresearch/src/interactive-pty.ts` | create | New class wrapping a plain interactive bash PTY: spawn / write / resize / restart / getChildren / dispose. No marker parsing, no `run()`. |
| `autoresearch/scripts/test-interactive-pty.ts` | create | Unit tests for `InteractivePty`, mirroring the structure of `test-term.ts`. |
| `autoresearch/src/terminal.ts` | modify (line 40) | `TERM=dumb` → `TERM=xterm-256color`. Nothing else changes. |
| `autoresearch/src/web.ts` | modify (signature + protocol) | Accept `(cfg, main, cli, port)`. Broadcast `{type:"pty", term, data}`. Handle `restart-check` / `restart` per terminal. Re-emit `dead`/`restarted`/`restart-failed` over WS. |
| `autoresearch/src/index.ts` | modify (rewire) | Build three PTYs (`main`, `cli`, `loopTerm`). Pass only the user PTYs to `startWebServer`. `await runLoop(cfg, loopTerm)`. Replace stale comment. |
| `Autoresearch Dashboard.html` | modify (multiple regions) | Wire `cli.term` input/resize, tag `main` input with `term`, dispatch ws messages by `m.term`, add ↻ restart buttons + dead banners + exponential-backoff reconnect. |
| `autoresearch/scripts/run-all-tests.sh` | modify (add suite) | Add `M3 interactive-pty` suite alongside the existing M1/M2/M4. |

---

## Task 1: InteractivePty — spawn, data, write, dispose

**Files:**
- Create: `autoresearch/src/interactive-pty.ts`
- Test: `autoresearch/scripts/test-interactive-pty.ts`

- [ ] **Step 1: Write the failing test**

Create `autoresearch/scripts/test-interactive-pty.ts`:

```ts
/**
 * InteractivePty unit tests.
 *
 * Mirrors test-term.ts pattern: bare TS run via tsx, manual asserts.
 */

import { InteractivePty } from "../src/interactive-pty";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗  ${name}\n     ${msg}`);
    failed++;
  }
}

function eq<T>(label: string, got: T, want: T): void {
  if (got !== want) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("\n=== interactive-pty.ts tests ===\n");

  // ── Test 1: spawn → alive=true, pid set ───────────────────────────────────
  await test("start() → alive=true, pid is positive integer", async () => {
    const p = new InteractivePty();
    await p.start();
    eq("alive", p.alive, true);
    if (typeof p.pid !== "number" || p.pid <= 0) {
      throw new Error(`pid = ${p.pid}, want positive number`);
    }
    p.dispose();
  });

  // ── Test 2: data event fires when writing ─────────────────────────────────
  await test("write('echo HI\\n') triggers data event containing 'HI'", async () => {
    const p = new InteractivePty();
    await p.start();
    let buf = "";
    p.on("data", (d: string) => { buf += d; });
    p.write("echo HI\n");
    // Wait up to 2s for echo to round-trip
    for (let i = 0; i < 40 && !buf.includes("HI"); i++) await sleep(50);
    if (!buf.includes("HI")) {
      throw new Error(`echo never came back. buf=${JSON.stringify(buf)}`);
    }
    p.dispose();
  });

  // ── Test 3: dispose() → alive=false + 'dead' event ────────────────────────
  await test("dispose() → alive=false and 'dead' event fires", async () => {
    const p = new InteractivePty();
    await p.start();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("dead never fired (5s)")), 5000);
      p.once("dead", () => { clearTimeout(t); resolve(); });
      p.dispose();
    });
    eq("alive after dispose", p.alive, false);
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error("[test-interactive-pty] fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `autoresearch/`:
```bash
cd autoresearch && npx tsx scripts/test-interactive-pty.ts
```

Expected: FAIL with `Cannot find module '../src/interactive-pty'`.

- [ ] **Step 3: Write minimal implementation**

Create `autoresearch/src/interactive-pty.ts`:

```ts
import * as pty from "node-pty";
import { EventEmitter } from "events";

/**
 * InteractivePty — plain interactive bash PTY for the dashboard.
 *
 * No marker wrapping, no run() method. Just relays bytes both directions.
 * Used by main/cli terminals; the loop's automation uses Terminal instead.
 */
export class InteractivePty extends EventEmitter {
  alive = false;
  pid: number | null = null;

  private proc: pty.IPty | null = null;

  async start(): Promise<void> {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }

    this.proc = pty.spawn("bash", ["--noprofile", "--norc"], {
      name: "xterm-256color",
      cols: 220,
      rows: 50,
      env:  { ...process.env, TERM: "xterm-256color", PS1: "$ " },
    });

    this.alive = true;
    this.pid   = this.proc.pid;

    this.proc.onData((d: string) => {
      this.emit("data", d);
    });

    this.proc.onExit((e: { exitCode: number; signal?: number }) => {
      this.alive = false;
      const pid = this.pid;
      this.pid = null;
      this.emit("dead", { code: e.exitCode, signal: e.signal ?? null, pid });
    });
  }

  write(data: string): void {
    if (!this.alive || !this.proc) return;
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.alive || !this.proc) return;
    try { this.proc.resize(cols, rows); } catch { /* ignore */ }
  }

  dispose(): void {
    this.alive = false;
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd autoresearch && npx tsx scripts/test-interactive-pty.ts
```

Expected: `3 tests — 3 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add autoresearch/src/interactive-pty.ts autoresearch/scripts/test-interactive-pty.ts
git commit -m "feat: add InteractivePty class with spawn/write/dispose"
```

---

## Task 2: InteractivePty — getChildren()

**Files:**
- Modify: `autoresearch/src/interactive-pty.ts` (add `getChildren` method)
- Modify: `autoresearch/scripts/test-interactive-pty.ts` (append tests)

- [ ] **Step 1: Append failing tests**

Add inside `main()` of `test-interactive-pty.ts`, before the Summary:

```ts
  // ── Test 4: getChildren() empty when idle ─────────────────────────────────
  await test("getChildren() returns [] when bash is idle", async () => {
    const p = new InteractivePty();
    await p.start();
    await sleep(200); // let bash settle
    const kids = await p.getChildren();
    if (kids.length !== 0) {
      throw new Error(`expected [], got ${JSON.stringify(kids)}`);
    }
    p.dispose();
  });

  // ── Test 5: getChildren() lists running child ─────────────────────────────
  await test("getChildren() lists 'sleep' while sleep is running", async () => {
    const p = new InteractivePty();
    await p.start();
    p.write("sleep 30 &\n");
    await sleep(300); // give bash time to fork
    const kids = await p.getChildren();
    p.dispose();
    if (!kids.some((k) => k.cmd.includes("sleep"))) {
      throw new Error(`expected sleep child, got ${JSON.stringify(kids)}`);
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd autoresearch && npx tsx scripts/test-interactive-pty.ts
```

Expected: FAIL with `p.getChildren is not a function` on tests 4 and 5.

- [ ] **Step 3: Implement getChildren**

Add to `autoresearch/src/interactive-pty.ts`, inside the class (before `dispose`):

```ts
  /**
   * List child processes spawned beneath this PTY's bash, e.g. a running
   * `copilot` or `sleep` command. Returns [] when bash is idle.
   *
   * Strategy:
   *   1. Try `pgrep -P <pid> -a` (returns "PID command-line" lines).
   *   2. Fallback: read /proc/<pid>/task/* /children + ps -o comm= for each.
   */
  async getChildren(): Promise<{ pid: number; cmd: string }[]> {
    if (!this.alive || this.pid == null) return [];
    const parent = this.pid;

    const pgrep = await this._exec(`pgrep -P ${parent} -a`);
    if (pgrep.code === 0 && pgrep.stdout.trim()) {
      return pgrep.stdout.trim().split("\n").map((line) => {
        const sp = line.indexOf(" ");
        const pid = Number(sp < 0 ? line : line.slice(0, sp));
        const cmd = sp < 0 ? "" : line.slice(sp + 1);
        return { pid, cmd };
      });
    }

    // Fallback: /proc/<pid>/task/*/children
    const fs = await import("fs");
    const path = await import("path");
    const taskDir = `/proc/${parent}/task`;
    if (!fs.existsSync(taskDir)) return [];
    const childPids = new Set<number>();
    for (const tid of fs.readdirSync(taskDir)) {
      const file = path.join(taskDir, tid, "children");
      try {
        for (const s of fs.readFileSync(file, "utf8").trim().split(/\s+/)) {
          if (s) childPids.add(Number(s));
        }
      } catch { /* ignore */ }
    }
    const out: { pid: number; cmd: string }[] = [];
    for (const cpid of childPids) {
      const ps = await this._exec(`ps -o comm= -p ${cpid}`);
      out.push({ pid: cpid, cmd: ps.stdout.trim() });
    }
    return out;
  }

  private _exec(cmd: string): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve) => {
      const cp = require("child_process");
      cp.exec(cmd, { encoding: "utf8" }, (err: { code?: number } | null, stdout: string) => {
        resolve({ code: err?.code ?? 0, stdout: stdout ?? "" });
      });
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd autoresearch && npx tsx scripts/test-interactive-pty.ts
```

Expected: `5 tests — 5 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add autoresearch/src/interactive-pty.ts autoresearch/scripts/test-interactive-pty.ts
git commit -m "feat: InteractivePty.getChildren() with pgrep + /proc fallback"
```

---

## Task 3: InteractivePty — restart()

**Files:**
- Modify: `autoresearch/src/interactive-pty.ts` (add `restart` method)
- Modify: `autoresearch/scripts/test-interactive-pty.ts` (append tests)

- [ ] **Step 1: Append failing tests**

Add inside `main()` of `test-interactive-pty.ts`, before Summary:

```ts
  // ── Test 6: restart() emits 'restarted' and assigns new pid ───────────────
  await test("restart() kills, respawns, emits 'restarted', new pid differs", async () => {
    const p = new InteractivePty();
    await p.start();
    const oldPid = p.pid;
    const restarted = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("restarted never fired (10s)")), 10000);
      p.once("restarted", () => { clearTimeout(t); resolve(); });
    });
    await p.restart();
    await restarted;
    if (!p.alive) throw new Error("alive=false after restart");
    if (p.pid === oldPid) throw new Error(`pid did not change: ${p.pid}`);
    p.dispose();
  });

  // ── Test 7: restart() kills lingering child processes ─────────────────────
  await test("restart() kills child processes (sleep)", async () => {
    const p = new InteractivePty();
    await p.start();
    p.write("sleep 60 &\n");
    await sleep(300);
    const before = await p.getChildren();
    if (!before.some((k) => k.cmd.includes("sleep"))) {
      throw new Error("sleep didn't start");
    }
    await p.restart();
    await sleep(200);
    const after = await p.getChildren();
    if (after.length !== 0) {
      throw new Error(`children survived restart: ${JSON.stringify(after)}`);
    }
    p.dispose();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd autoresearch && npx tsx scripts/test-interactive-pty.ts
```

Expected: FAIL with `p.restart is not a function` on tests 6 and 7.

- [ ] **Step 3: Implement restart**

Add to `autoresearch/src/interactive-pty.ts`, inside the class (before `getChildren`):

```ts
  /**
   * SIGTERM → 100ms grace → SIGKILL → wait for onExit → re-spawn.
   * Emits "restarted" on success, "restart-failed" with reason on failure.
   *
   * Concurrent calls are serialized — a second call while one is in-flight
   * returns the same Promise and does not spawn a duplicate PTY.
   */
  private _restartPromise: Promise<void> | null = null;

  async restart(): Promise<void> {
    if (this._restartPromise) return this._restartPromise;
    this._restartPromise = this._doRestart()
      .finally(() => { this._restartPromise = null; });
    return this._restartPromise;
  }

  private async _doRestart(): Promise<void> {
    if (this.proc) {
      const proc = this.proc;
      const exited = new Promise<void>((resolve) => {
        proc.onExit(() => resolve());
      });
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      const winner = await Promise.race([
        exited.then(() => "exit" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
      ]);
      if (winner === "timeout") {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        await exited;
      }
    }

    try {
      await this.start();
      this.emit("restarted");
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      this.emit("restart-failed", { reason });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd autoresearch && npx tsx scripts/test-interactive-pty.ts
```

Expected: `7 tests — 7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add autoresearch/src/interactive-pty.ts autoresearch/scripts/test-interactive-pty.ts
git commit -m "feat: InteractivePty.restart() with SIGTERM→SIGKILL graceful kill"
```

---

## Task 4: terminal.ts — TERM=xterm-256color

**Files:**
- Modify: `autoresearch/src/terminal.ts:40`

- [ ] **Step 1: Make the change**

Edit `autoresearch/src/terminal.ts` line 40:

Change:
```ts
      env:  { ...process.env, TERM: "dumb" },
```
to:
```ts
      env:  { ...process.env, TERM: "xterm-256color" },
```

- [ ] **Step 2: Run existing terminal test to verify no regression**

```bash
cd autoresearch && npm run test:term
```

Expected: all 9 tests pass (the test does not depend on TERM value).

- [ ] **Step 3: Commit**

```bash
git add autoresearch/src/terminal.ts
git commit -m "fix: TERM=xterm-256color so loop subprocesses render correctly"
```

---

## Task 5: web.ts — accept main + cli, dispatch by term

**Files:**
- Modify: `autoresearch/src/web.ts` (signature + protocol)

- [ ] **Step 1: Read the current implementation**

Open `autoresearch/src/web.ts` and locate:
- Imports (lines 19-27)
- `startWebServer` signature (line 189)
- `term.on("data", ...)` (lines 220-222)
- `wss.on("connection", ...)` message handler (lines 224-275)

- [ ] **Step 2: Update imports and signature**

Replace the import at line 24:
```ts
import { Terminal } from "./terminal";
```
with:
```ts
import { InteractivePty } from "./interactive-pty";
```

Replace the function signature at line 189-193:
```ts
export function startWebServer(
  cfg:   Config,
  term:  Terminal,
  port = 8080,
): void {
```
with:
```ts
export function startWebServer(
  cfg:   Config,
  main:  InteractivePty,
  cli:   InteractivePty,
  port = 8080,
): void {
```

- [ ] **Step 3: Wire data/dead/restarted events for both PTYs**

Replace the broadcast block at lines 219-222:
```ts
  // Forward raw PTY bytes to all clients
  term.on("data", (d: string) => {
    broadcast(wss, { type: "pty", data: d });
  });
```
with:
```ts
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
```

- [ ] **Step 4: Update connection handler — initial state + dispatch by term**

Inside `wss.on("connection", ...)` (around line 224-275), update the initial-state push and message handler.

Replace the initial `ws.send` block at lines 226-235:
```ts
    ws.send(JSON.stringify({
      type:  "status",
      iter:  loopState.iter,
      total: cfg.iterations,
      phase: loopState.phase,
      best:  bestSoFar(cfg.tsvPath, cfg.direction),
      alive: term.alive,
    } satisfies StatusMsg));
    ws.send(JSON.stringify(getGitStatus(cfg.workdir)));
    ws.send(JSON.stringify(getLogFiles(cfg)));
```
with:
```ts
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
```

Replace the inner `ws.on("message", ...)` body at lines 238-274:
```ts
    ws.on("message", (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === "input")  (term as any).proc?.write(m.data);
        if (m.type === "resize") (term as any).proc?.resize(m.cols, m.rows);
        if (m.type === "config" && typeof m.dryRun === "boolean") {
          runtime.dryRun = m.dryRun;
          console.error(`[web] dryRun = ${runtime.dryRun}`);
          broadcast(wss, { type: "toast", msg: `Dry Run ${runtime.dryRun ? "ON" : "OFF"}` });
        }
        if (m.type === "loop" && m.action === "start") {
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
          execSync(`git reset --hard ${m.hash}`, { cwd: cfg.workdir });
          console.error(`[web] applied ${m.hash}`);
          broadcast(wss, getGitStatus(cfg.workdir));
          broadcast(wss, getHistory(cfg));
          broadcast(wss, {
            type: "toast",
            msg:  `Applied ${m.hash} — restart loop to iterate from here`,
          });
        }
      } catch (e) { console.error("[web] ws message error:", e); }
    });
```
with:
```ts
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
          execSync(`git reset --hard ${m.hash}`, { cwd: cfg.workdir });
          console.error(`[web] applied ${m.hash}`);
          broadcast(wss, getGitStatus(cfg.workdir));
          broadcast(wss, getHistory(cfg));
          broadcast(wss, {
            type: "toast",
            msg:  `Applied ${m.hash} — restart loop to iterate from here`,
          });
        }
      } catch (e) { console.error("[web] ws message error:", e); }
    });
```

- [ ] **Step 5: Update periodic status push**

Inside the `setInterval` block at lines 279-291, change the `alive` field:

From:
```ts
      alive: term.alive,
```
to:
```ts
      alive: main.alive && cli.alive,
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd autoresearch && npm run build
```

Expected: no errors. (Note: `index.ts` will fail compile until Task 6 — proceed anyway, the per-file change is correct.)

If `index.ts` errors are the only ones, that's fine. Any error in `web.ts` itself must be fixed before continuing.

- [ ] **Step 7: Commit**

```bash
git add autoresearch/src/web.ts
git commit -m "feat(web): dual PTY broadcast with per-term input/restart protocol"
```

---

## Task 6: index.ts — wire three PTYs

**Files:**
- Modify: `autoresearch/src/index.ts`

- [ ] **Step 1: Replace the wiring**

Replace the current contents of `autoresearch/src/index.ts` with:

```ts
import { load } from "./config";
import { runLoop } from "./loop";
import { startWebServer } from "./web";
import { Terminal } from "./terminal";
import { InteractivePty } from "./interactive-pty";

const cfgPath = process.argv[2] ?? "autoresearch.yml";
const port    = Number(process.env.AR_PORT ?? 8080);

process.on("SIGINT", () => {
  console.error("\n[autoresearch] SIGINT — exiting");
  process.exit(130);
});

const cfg = load(cfgPath);

(async () => {
  // Three PTYs: main + cli are interactive (dashboard owns them); loopTerm
  // runs the loop's automation in isolation so user keystrokes never
  // collide with marker parsing.
  const main     = new InteractivePty();
  const cli      = new InteractivePty();
  const loopTerm = new Terminal();

  await main.start();
  await cli.start();
  await loopTerm.start();

  startWebServer(cfg, main, cli, port);

  await runLoop(cfg, loopTerm);
})().catch((e: unknown) => {
  console.error("[autoresearch] fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd autoresearch && npm run build
```

Expected: no errors.

- [ ] **Step 3: Smoke test the server**

```bash
cd autoresearch && npx tsx src/index.ts &
SERVER_PID=$!
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080
kill $SERVER_PID 2>/dev/null
```

Expected: `200` printed. Server log shows `[web] Dashboard → http://localhost:8080`.

- [ ] **Step 4: Commit**

```bash
git add autoresearch/src/index.ts
git commit -m "refactor(index): wire three PTYs (main, cli, loopTerm)"
```

---

## Task 7: Dashboard HTML — wire `cli` input and resize

**Files:**
- Modify: `Autoresearch Dashboard.html` (around lines 363-368)

- [ ] **Step 1: Read the current block**

Locate this section in `Autoresearch Dashboard.html` (near line 363-368):

```js
const main = makeTerm('term-main');
const cli  = makeTerm('term-cli');
main.term.focus();

// Resize both on window resize
new ResizeObserver(() => { main.fit.fit(); cli.fit.fit(); }).observe(document.getElementById('center'));
```

- [ ] **Step 2: Add `cli` input/resize wiring**

Insert immediately after the `main.term.focus();` line:

```js
// Wire cli terminal: forward keystrokes and resize to server (term:"cli").
cli.term.onData(d => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:'input', term:'cli', data:d }));
  } else {
    // Demo / disconnected fallback: local echo so the terminal looks responsive.
    if (d === '\r') cli.term.write('\r\n');
    else if (d === '\x7f') cli.term.write('\b \b');
    else cli.term.write(d);
  }
});
cli.term.onResize(({cols,rows}) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:'resize', term:'cli', cols, rows }));
  }
});
```

- [ ] **Step 3: Manual verify (will be tested fully in Task 12)**

No standalone test possible yet — the server doesn't yet route `term:"cli"` input until Task 5 is committed. Since Task 5 is committed, you can spot-check by:
```bash
cd autoresearch && npx tsx src/index.ts &
sleep 2
# Open http://localhost:8080 in browser
# Type in the lower (cli) terminal — it should NOT crash. Output won't render
# fully until Task 8 wires `m.term` dispatch.
kill %1 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): wire cli terminal onData/onResize to ws"
```

---

## Task 8: Dashboard HTML — tag `main` input + dispatch by term

**Files:**
- Modify: `Autoresearch Dashboard.html` (lines 623-641)

- [ ] **Step 1: Update `main.term.onData` to include term field**

Locate the existing block at lines 623-627:

```js
main.term.onData(d => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'input', data:d }));
  else { if(d==='\r') main.term.write('\r\n'); else if(d==='\x7f') main.term.write('\b \b'); else main.term.write(d); }
});
main.term.onResize(({cols,rows}) => { if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'resize',cols,rows})); });
```

Replace with:

```js
main.term.onData(d => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'input', term:'main', data:d }));
  else { if(d==='\r') main.term.write('\r\n'); else if(d==='\x7f') main.term.write('\b \b'); else main.term.write(d); }
});
main.term.onResize(({cols,rows}) => { if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'resize', term:'main', cols, rows})); });
```

- [ ] **Step 2: Replace ws.onmessage dispatch**

Locate the block at lines 634-641:

```js
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type==='pty')     main.term.write(m.data);
      if (m.type==='cli')     cli.term.write(m.data);
      if (m.type==='status')  updateStatus(m);
      if (m.type==='history') renderHistory(m);
      if (m.type==='toast')   showToast(m.msg);
    };
```

Replace with:

```js
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'pty') {
        (m.term === 'cli' ? cli : main).term.write(m.data);
      } else if (m.type === 'dead') {
        showDeadBanner(m.term, m);
      } else if (m.type === 'restarted') {
        (m.term === 'cli' ? cli : main).term.reset();
        hideDeadBanner(m.term);
      } else if (m.type === 'restart-failed') {
        showToast(`Restart failed (${m.term}): ${m.reason}`);
      } else if (m.type === 'restart-check-result') {
        handleRestartCheck(m);
      } else if (m.type === 'status') {
        updateStatus(m);
      } else if (m.type === 'history') {
        renderHistory(m);
      } else if (m.type === 'toast') {
        showToast(m.msg);
      }
    };
```

- [ ] **Step 3: Add stub helpers (real ones come in Tasks 9-10)**

Right above the `function connectWS()` definition (search for `function connectWS()` — around line 629), insert these stubs so step 2's references resolve while we build them out:

```js
// Stubs — fully implemented in restart-button (Task 9) and dead-banner (Task 10) tasks.
function showDeadBanner(term, info)  { console.warn(`[dashboard] ${term} died:`, info); }
function hideDeadBanner(term)        { /* no-op until Task 10 */ }
function handleRestartCheck(m)       { /* no-op until Task 9 */ }
```

- [ ] **Step 4: Smoke test in browser**

```bash
cd autoresearch && npx tsx src/index.ts &
sleep 2
# Open http://localhost:8080
# Click into upper (main) terminal, type `echo HI`, press Enter — see "HI".
# Click into lower (cli) terminal, type `pwd`, press Enter — see the working dir.
kill %1 2>/dev/null
```

Expected: both terminals echo and execute commands. Bash prompt `$` is visible.

- [ ] **Step 5: Commit**

```bash
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): per-term ws dispatch with main/cli routing"
```

---

## Task 9: Dashboard HTML — restart buttons + confirmation

**Files:**
- Modify: `Autoresearch Dashboard.html`

- [ ] **Step 1: Add restart-btn CSS**

Locate the `.term-inner` rule (around line 172). Insert these rules immediately after it:

```css
.restart-btn {
  background: transparent; border: 1px solid rgba(255,255,255,0.15);
  color: var(--dim); padding: 0 6px; border-radius: 3px; cursor: pointer;
  font-size: 12px; line-height: 14px;
}
.restart-btn:hover { color: var(--blue); border-color: var(--blue); }
```

- [ ] **Step 2: Add ↻ button to each terminal title bar**

The current structure (lines 294-308) is:

```html
  <div class="term-wrap" id="term-main-wrap">
    <div class="term-label">
      <div class="tl-dot active" id="main-dot"></div>
      Main Terminal — 系统 / 用户输入
    </div>
    <div class="term-inner" id="term-main"></div>
  </div>
  <div id="divider"></div>
  <div class="term-wrap" id="term-cli-wrap">
    <div class="term-label">
      <div class="tl-dot" id="cli-dot"></div>
      Copilot CLI — Stage 1 专用
    </div>
    <div class="term-inner" id="term-cli"></div>
  </div>
```

Replace exactly that block with:

```html
  <div class="term-wrap" id="term-main-wrap">
    <div class="term-label">
      <div class="tl-dot active" id="main-dot"></div>
      <span style="flex:1">Main Terminal — 系统 / 用户输入</span>
      <button class="restart-btn" onclick="requestRestart('main')" title="Restart main bash">↻</button>
    </div>
    <div class="term-inner" id="term-main"></div>
  </div>
  <div id="divider"></div>
  <div class="term-wrap" id="term-cli-wrap">
    <div class="term-label">
      <div class="tl-dot active" id="cli-dot"></div>
      <span style="flex:1">Copilot CLI — Stage 1 专用</span>
      <button class="restart-btn" onclick="requestRestart('cli')" title="Restart cli bash">↻</button>
    </div>
    <div class="term-inner" id="term-cli"></div>
  </div>
```

Notes:
- `.term-label` is already `display:flex` (lines 163-169), so the dot, the flex-1 span, and the button align horizontally with the title filling the middle space.
- `tl-dot` stays a `<div>` so its existing fixed width/height CSS keeps working.

- [ ] **Step 3: Implement requestRestart and handleRestartCheck**

Replace the stub `function handleRestartCheck(m) { /* no-op until Task 9 */ }` (added in Task 8 step 3) with the real pair. Insert just above `function connectWS()`:

```js
function requestRestart(term) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast(`Cannot restart ${term}: WS disconnected`);
    return;
  }
  ws.send(JSON.stringify({ type:'restart-check', term }));
}

function handleRestartCheck(m) {
  if (!m.hasChildren) {
    ws.send(JSON.stringify({ type:'restart', term: m.term }));
    return;
  }
  const cmds = (m.childCmds || []).filter(Boolean).join(', ') || '(unknown)';
  if (confirm(`正在运行: ${cmds}\n确认重启 ${m.term} 终端?`)) {
    ws.send(JSON.stringify({ type:'restart', term: m.term }));
  }
}
```

(Leave `showDeadBanner` / `hideDeadBanner` as stubs — Task 10 finishes those.)

- [ ] **Step 4: Manual verify**

```bash
cd autoresearch && npx tsx src/index.ts &
sleep 2
# Open http://localhost:8080
# Click ↻ next to "Main Terminal" — silent restart (terminal clears, bash respawns).
# In cli terminal: type `sleep 60`, Enter.
# Click ↻ next to "Copilot CLI" — confirm dialog appears listing "sleep 60".
# Cancel: nothing happens. Click ↻ again, accept: terminal resets, sleep killed.
kill %1 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): per-terminal restart button with child-process confirm"
```

---

## Task 10: Dashboard HTML — dead-terminal indicator

**Goal:** When a PTY dies, write a red message into the xterm and turn the status dot red. Restart returns it to green.

The `.term-label` is `position:absolute; top:0` with `.term-inner` at `inset:22px 0 0 0`, so injecting a separate banner into the layout requires fighting the existing absolute positioning. We avoid that by signaling death **inside the xterm** (a red ANSI line) and **on the existing dot** (red color).

**Files:**
- Modify: `Autoresearch Dashboard.html`

- [ ] **Step 1: Add `.tl-dot.dead` CSS rule**

Locate the existing dot rules (line 170-171):

```css
.term-label .tl-dot { width:6px; height:6px; border-radius:50%; background:var(--border); }
.term-label .tl-dot.active { background:var(--green); }
```

After line 171, insert:

```css
.term-label .tl-dot.dead { background:var(--red); }
```

- [ ] **Step 2: Replace stub helpers with real implementations**

Replace the stubs added in Task 8 step 3:

```js
function showDeadBanner(term, info)  { console.warn(`[dashboard] ${term} died:`, info); }
function hideDeadBanner(term)        { /* no-op until Task 10 */ }
```

with:

```js
function showDeadBanner(term, info) {
  const xterm = (term === 'cli' ? cli : main).term;
  const code   = info?.code   ?? '?';
  const signal = info?.signal ? ` (signal ${info.signal})` : '';
  // Red ANSI message inside the terminal itself.
  xterm.write(`\r\n\x1b[1;31m── ${term} terminal exited (code ${code}${signal}) — click ↻ to restart ──\x1b[0m\r\n`);
  const dot = document.getElementById(`${term}-dot`);
  if (dot) { dot.classList.remove('active'); dot.classList.add('dead'); }
}

function hideDeadBanner(term) {
  const dot = document.getElementById(`${term}-dot`);
  if (dot) { dot.classList.remove('dead'); dot.classList.add('active'); }
}
```

- [ ] **Step 3: Manual verify**

```bash
cd autoresearch && npx tsx src/index.ts &
SERVER_PID=$!
sleep 2
# Open http://localhost:8080. Both dots should be green.
# Find PTY child pids:
pgrep -P $SERVER_PID
# Pick one and SIGKILL it (mapping is order-dependent: first started is `main`):
kill -9 <pid>
# Browser: that terminal shows a red "── <term> terminal exited (code X) — click ↻ ──"
# line; its dot turns red.
# Click ↻ in that terminal's titlebar. Dot returns to green; terminal clears; bash respawns.
kill $SERVER_PID 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): in-terminal red death message + red status dot"
```

---

## Task 11: Dashboard HTML — exponential-backoff WS reconnect

**Files:**
- Modify: `Autoresearch Dashboard.html` (around line 629-643)

- [ ] **Step 1: Replace `connectWS` with backoff version**

Locate the existing `connectWS` function around lines 629-643 and replace the entire function body with:

```js
let wsReconnectAttempt = 0;
const WS_DELAYS = [1000, 2000, 5000, 10000, 30000]; // cap at 30s

function connectWS() {
  try {
    ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => {
      wsReconnectAttempt = 0;
      document.getElementById('ws-dot').className = 'ws-dot connected';
      document.getElementById('ws-label').textContent = '已连接';
    };
    ws.onclose = () => {
      ws = null;
      document.getElementById('ws-dot').className = 'ws-dot demo';
      document.getElementById('ws-label').textContent = '断开 — 重连中…';
      const delay = WS_DELAYS[Math.min(wsReconnectAttempt, WS_DELAYS.length - 1)];
      wsReconnectAttempt++;
      // After 3 attempts, also fall back to demo so the page doesn't look dead.
      if (wsReconnectAttempt === 3 && !demoRunning) startDemo();
      setTimeout(connectWS, delay);
    };
    ws.onerror = () => { /* onclose will handle reconnect */ };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'pty') {
        (m.term === 'cli' ? cli : main).term.write(m.data);
      } else if (m.type === 'dead') {
        showDeadBanner(m.term, m);
      } else if (m.type === 'restarted') {
        (m.term === 'cli' ? cli : main).term.reset();
        hideDeadBanner(m.term);
      } else if (m.type === 'restart-failed') {
        showToast(`Restart failed (${m.term}): ${m.reason}`);
      } else if (m.type === 'restart-check-result') {
        handleRestartCheck(m);
      } else if (m.type === 'status') {
        updateStatus(m);
      } else if (m.type === 'history') {
        renderHistory(m);
      } else if (m.type === 'toast') {
        showToast(m.msg);
      }
    };
  } catch {
    setTimeout(startDemo, 0);
  }
}
```

(The `ws.onmessage` body is identical to Task 8's — copy intact, do not regress.)

- [ ] **Step 2: Manual verify reconnect**

```bash
cd autoresearch && npx tsx src/index.ts &
sleep 2
# Open http://localhost:8080. Confirm "已连接" indicator.
# Kill the server:
kill %1
# In browser console, watch the WS reconnect attempts (1s, 2s, 5s...).
# Indicator should show "断开 — 重连中…".
# Restart server:
cd autoresearch && npx tsx src/index.ts &
sleep 3
# Indicator returns to "已连接" without page reload.
kill %1 2>/dev/null
```

- [ ] **Step 3: Commit**

```bash
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): exponential-backoff WS reconnect (1/2/5/10/30s)"
```

---

## Task 12: Wire new test suite into run-all-tests.sh

**Files:**
- Modify: `autoresearch/scripts/run-all-tests.sh`
- Modify: `autoresearch/package.json` (new npm script)

- [ ] **Step 1: Add npm script**

Edit `autoresearch/package.json`. After the `"test:errors": "tsx scripts/test-errors.ts",` line, insert:

```json
    "test:pty":     "tsx scripts/test-interactive-pty.ts",
```

- [ ] **Step 2: Add suite to run-all-tests.sh**

In `autoresearch/scripts/run-all-tests.sh`, after the line:
```bash
run_suite "M1  terminal" "tsx scripts/test-term.ts"
```
insert:
```bash
run_suite "M3  interactive-pty" "tsx scripts/test-interactive-pty.ts"
```

- [ ] **Step 3: Run all tests**

```bash
cd autoresearch && npm test
```

Expected: all four suites pass.

- [ ] **Step 4: Commit**

```bash
git add autoresearch/package.json autoresearch/scripts/run-all-tests.sh
git commit -m "test: wire interactive-pty suite into run-all-tests.sh"
```

---

## Task 13: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full spec test scenarios**

Boot the server:
```bash
cd autoresearch && npx tsx src/index.ts
```

Open `http://localhost:8080`. Walk through every scenario from the spec's Testing section:

1. Type `echo hello` in `main`, Enter → see output.
2. Type `copilot` in `cli`, complete TUI login flow (URL → token → submit), confirm copilot reports authenticated.
3. Click ↻ on `cli` while bash is idle → silent reset.
4. `sleep 60` in `main`, click ↻ → confirm dialog lists `sleep`. Cancel: no-op. Restart: bash respawns, screen clears.
5. From another shell: `kill -9` the bash pid for `cli` → red banner appears. Click ↻ → terminal returns.
6. Start the loop while typing in `main` — verify both proceed independently. Inspect `loop.log` to confirm intact `__OUT__` / `__EXIT__` markers.
7. Stop the WS server (Ctrl-C); browser console shows reconnect attempts; restart server; live mode resumes without reload.

- [ ] **Step 2: Run the full type-check + tests**

```bash
cd autoresearch && npm run build && npm test
```

Expected: `tsc --noEmit` passes; all four test suites pass.

- [ ] **Step 3: Final commit (only if any docs/cleanup needed)**

If anything in the spec testing scenarios surfaced an issue you fixed, commit it now with a descriptive message. If everything was clean, skip this step.

---

## Notes for the Implementer

- **Order matters.** Tasks 1-3 build the new class with TDD. Task 4 is independent. Tasks 5-6 update the server wiring; the project will not compile cleanly between Task 5 and Task 6 — that is expected. Tasks 7-11 each leave the dashboard in a working (if sparse) state. Task 12-13 close out.
- **Don't rewrite files wholesale.** Use targeted edits. The HTML files are large — read the surrounding 5-10 lines before editing to keep `old_string` unique.
- **Run tests as you go.** The TDD steps are fast; do not batch them. The suite is bare TS (`tsx`), no jest/vitest.
- **Manual browser tests are part of the plan.** The dashboard has no automated UI test framework. The verification commands are the substitute.
- **Commit frequently.** Each task ends with a commit. Do not amend.
