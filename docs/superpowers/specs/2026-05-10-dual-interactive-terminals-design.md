# Dual Interactive Terminals — Design

**Date:** 2026-05-10
**Status:** approved (high-level), awaiting spec review
**Topic:** make both terminals in `Autoresearch Dashboard.html` real, always-on interactive PTYs; isolate the loop's automation from the user's terminals; add restart buttons.

## Problem

The dashboard exposes two `xterm.js` terminals (`main`, `cli`). The current wiring breaks interactive use:

- The `cli` terminal has no `onData` listener at all — typing does nothing ([Autoresearch Dashboard.html:364](../../../Autoresearch%20Dashboard.html#L364)).
- The server never sends `{type:"cli",...}` ([src/web.ts:220-222](../../../autoresearch/src/web.ts#L220-L222)), so even if it had output it would never display.
- The single PTY behind `main` is configured for non-interactive automation: `TERM=dumb` and `stty -echo` ([src/terminal.ts:36-63](../../../autoresearch/src/terminal.ts#L36-L63)). Copilot's TUI cannot render, and user keystrokes are invisible.
- The loop drives that same PTY via `Terminal.run()` with `__OUT__/__EXIT__` marker wrapping. Any human input would race with the marker parser.

Net effect: the user cannot complete the multi-step interactive flow that `copilot` requires (TUI menu → URL → paste token → submit).

## Goals

1. Two always-on interactive terminals (`main`, `cli`) backed by real PTYs that accept all keystrokes including `\r` (no separate Enter button needed).
2. Loop automation runs in physical isolation from user terminals so user input cannot corrupt marker parsing or interleave with the loop's commands.
3. Per-terminal restart button, with a confirmation prompt only when child processes are running.
4. PTY death and WebSocket disconnects are handled robustly — the user can recover without reloading the page.

## Non-goals

- `Autoresearch Loop.html` is out of scope.
- No streaming of loop output into a dedicated UI panel — `status` messages and the existing log-files panel suffice.
- No custom modal framework — native `confirm()` is acceptable.
- No automatic copilot-login detection. The user types `copilot` themselves.

## Architecture

Three PTYs total:

| PTY | Class | Role | Broadcast to UI |
|---|---|---|---|
| `main` | `InteractivePty` (new) | User scratch terminal | yes, as `{type:"pty", term:"main"}` |
| `cli` | `InteractivePty` (new) | User runs `copilot` here | yes, as `{type:"pty", term:"cli"}` |
| loop  | `Terminal` (existing) | Loop's `run()` automation | **no** |

The loop's `Terminal` instance is intentionally hidden from the dashboard. Its output continues to mirror to stderr and write through the existing `logger` to `loop.log`. The dashboard's existing log-files panel ([src/web.ts:168-185](../../../autoresearch/src/web.ts#L168-L185)) plus the periodic `status` push give users visibility into loop progress.

### `InteractivePty` (new, `src/interactive-pty.ts`)

Minimal interactive PTY wrapper.

```ts
class InteractivePty extends EventEmitter {
  alive: boolean;
  pid: number | null;

  start(): Promise<void>           // spawns bash, waits for sentinel
  write(data: string): void        // forward keystrokes to PTY
  resize(cols: number, rows: number): void
  restart(): Promise<void>         // SIGTERM → 100ms → SIGKILL → respawn → sentinel
  getChildren(): Promise<{pid:number, cmd:string}[]>  // pgrep -P, fallback /proc
  dispose(): void

  // events:
  //   "data"            — string, raw PTY bytes
  //   "dead"            — { code, signal }
  //   "restarted"       — fires after successful restart() completion
  //   "restart-failed"  — { reason }
}
```

Spawn config:
```
pty.spawn("bash", ["--noprofile", "--norc"], {
  name: "xterm-256color",
  cols: 220, rows: 50,
  env:  { ...process.env, TERM: "xterm-256color", PS1: "$ " },
})
```

No `stty -echo`, no marker wrapping, no `run()` method. The class does not parse output — it just relays bytes.

`getChildren()` strategy:
1. Try `pgrep -P <pid> -a` (returns `pid cmd` lines, ignoring the bash itself).
2. If `pgrep` exits non-zero or is missing, read directory `/proc/<pid>/task/*/children`, splitting space-separated PIDs, then `ps -o comm= -p <pid>` for each.
3. Result excludes the spawned bash itself (only its children).

`restart()` is server-authoritative. The sequence:
1. Send `SIGTERM` to the bash pid.
2. Wait up to 100ms for `onExit`.
3. If still alive, `SIGKILL`.
4. After `onExit` fires, set `alive=false`, then call `start()` again.
5. On sentinel success → emit `restarted`. On sentinel timeout (10s) → emit `restart-failed`.

### `Terminal` (loop's PTY, small change)

Change [src/terminal.ts:40](../../../autoresearch/src/terminal.ts#L40) `TERM` from `"dumb"` to `"xterm-256color"` so commands the loop runs (perf, build) emit colors normally and any TUI-aware tooling behaves predictably. All other logic is unchanged.

The loop's `Terminal` instance is constructed in `src/index.ts` but **not** passed to `startWebServer`. Its `data` events never reach the dashboard.

### `src/index.ts` (wiring)

```ts
const main     = new InteractivePty();
const cli      = new InteractivePty();
const loopTerm = new Terminal();

await main.start();
await cli.start();
await loopTerm.start();

startWebServer(cfg, main, cli, 8080);
await runLoop(cfg, loopTerm);
```

The existing comment block at [src/index.ts:17-20](../../../autoresearch/src/index.ts#L17-L20) ("One PTY shared by the dashboard and the loop…") becomes obsolete and should be replaced with a one-line note describing the three-PTY split.

### `src/web.ts` (signature change + protocol)

New signature: `startWebServer(cfg, main: InteractivePty, cli: InteractivePty, port=8080)`.

Both PTYs subscribe their `data` events to broadcasts:
```ts
main.on("data", d => broadcast(wss, { type:"pty", term:"main", data:d }));
cli .on("data", d => broadcast(wss, { type:"pty", term:"cli",  data:d }));
```

Same for `dead`, `restarted`, `restart-failed`.

WebSocket protocol (extended; old single-terminal forms are removed since the dashboard is the sole client):

| Direction | Message |
|---|---|
| S→C | `{type:"pty", term:"main"\|"cli", data:string}` |
| S→C | `{type:"dead", term, code:number\|null, signal:string\|null}` |
| S→C | `{type:"restarted", term}` |
| S→C | `{type:"restart-failed", term, reason:string}` |
| S→C | `{type:"restart-check-result", term, hasChildren:boolean, childCmds:string[]}` |
| S→C | `{type:"status", ...}` *(unchanged)* |
| S→C | `{type:"git", ...}` *(unchanged)* |
| S→C | `{type:"log", ...}` *(unchanged)* |
| S→C | `{type:"history", ...}` *(unchanged)* |
| S→C | `{type:"toast", msg}` *(unchanged)* |
| C→S | `{type:"input", term, data:string}` |
| C→S | `{type:"resize", term, cols:number, rows:number}` |
| C→S | `{type:"restart-check", term}` |
| C→S | `{type:"restart", term}` |
| C→S | `{type:"config",...}`, `{type:"loop",...}`, `{type:"apply",...}` *(unchanged)* |

Restart-check race fix: when the server receives `{type:"restart"}`, it re-runs `getChildren()` itself before killing — server-side state is the source of truth. The client-side check is purely advisory for the confirm dialog.

### `Autoresearch Dashboard.html` changes

1. **Wire `cli` input** ([line 364](../../../Autoresearch%20Dashboard.html#L364) area):
   ```js
   cli.term.onData(d => {
     if (ws?.readyState === WebSocket.OPEN)
       ws.send(JSON.stringify({ type:"input", term:"cli", data:d }));
   });
   cli.term.onResize(({cols,rows}) => {
     if (ws?.readyState === WebSocket.OPEN)
       ws.send(JSON.stringify({ type:"resize", term:"cli", cols, rows }));
   });
   ```
2. **Update `main` input** ([line 623-627](../../../Autoresearch%20Dashboard.html#L623-L627)) to include `term:"main"`.
3. **`ws.onmessage` dispatch** ([line 634-641](../../../Autoresearch%20Dashboard.html#L634-L641)):
   ```js
   if (m.type === "pty") {
     (m.term === "cli" ? cli : main).term.write(m.data);
   } else if (m.type === "dead")            showDeadBanner(m.term, m);
   else if (m.type === "restarted")         { (m.term==="cli"?cli:main).term.reset(); hideDeadBanner(m.term); }
   else if (m.type === "restart-failed")    showToast(`Restart failed (${m.term}): ${m.reason}`);
   else if (m.type === "restart-check-result") handleRestartCheck(m);
   else if (m.type === "status")            updateStatus(m);
   else if (m.type === "history")           renderHistory(m);
   else if (m.type === "toast")             showToast(m.msg);
   ```
4. **Restart buttons** in both terminal title bars ([line 297](../../../Autoresearch%20Dashboard.html#L297) and [line 305](../../../Autoresearch%20Dashboard.html#L305)):
   ```html
   <button class="restart-btn" onclick="requestRestart('main')" title="Restart">↻</button>
   ```
   Flow:
   ```js
   function requestRestart(term) {
     ws.send(JSON.stringify({ type:"restart-check", term }));
   }
   function handleRestartCheck({term, hasChildren, childCmds}) {
     const ok = !hasChildren ||
       confirm(`正在运行: ${childCmds.join(", ")}\n确认重启 ${term} 终端?`);
     if (ok) ws.send(JSON.stringify({ type:"restart", term }));
   }
   ```
5. **Dead banner**: a thin red `<div>` above each terminal, hidden by default, set visible on `{type:"dead"}` with text "Terminal exited (code N) — click ↻ to restart". Hidden again on `restarted`.
6. **WS reconnect** ([line 633](../../../Autoresearch%20Dashboard.html#L633)): replace the immediate `startDemo()` fallback with exponential backoff. Sequence: 1s, 2s, 5s, 10s, 30s (cap at 30s). After 3 consecutive failures, fall back to demo mode but keep retrying in the background; reconnect resumes live mode.

## Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| User types into main while loop running | Cannot happen — loop is on a separate hidden PTY. |
| User pastes large token into cli | xterm `onData` chunks into multiple sends; WS preserves order; bash receives as ordinary stdin. No special handling. |
| `pgrep` not installed | Fallback to `/proc/<pid>/task/*/children` + `ps -o comm=`. |
| PTY dies (bash crash, OOM-killed copilot) | `dead` event broadcast → red banner → user clicks ↻ → server restarts. |
| WebSocket dies mid-session | Exponential backoff reconnect; on reconnect, server re-sends initial state messages (`status`, `git`, `log`, `history`). Terminal scrollback is preserved client-side. |
| Restart while copilot is mid-prompt | Confirm dialog lists `copilot` in `childCmds`. User decides. |
| Restart race (child appears between check and restart) | Server re-runs `getChildren()` at restart time and proceeds anyway (the client already opted in). Documented behavior: confirmation reflects state at check time. |
| Sentinel timeout after restart | `restart-failed` event surfaced as toast; user can try again. |

## Testing

Manual scenarios (no automated test framework currently in `autoresearch/scripts/`):

1. Start server. Open dashboard. Type `echo hello` in `main`, `Enter` — see output.
2. Type `copilot` in `cli`, complete TUI login flow, paste token, confirm.
3. Click ↻ on `cli` while bash is idle — reset is silent.
4. Run a long sleep in `main` (`sleep 60`), click ↻ — confirm dialog lists `sleep`. Cancel: nothing happens. Restart again, accept: bash respawns, screen clears.
5. `kill -9` the bash pid for `cli` from outside — red banner appears. Click ↻ — terminal returns.
6. Start the loop from the dashboard while typing in `main` — verify both proceed independently. Inspect `loop.log` to confirm the loop's automation ran with intact markers.
7. Stop the WS server, observe reconnect attempts in browser console; restart server; verify live mode resumes.

## Open questions

None.
