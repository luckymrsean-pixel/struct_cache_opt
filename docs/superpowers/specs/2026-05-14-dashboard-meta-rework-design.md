# Dashboard Meta-Loop Rework — Design

**Date:** 2026-05-14
**Branch:** meta-loop-phase1
**Status:** Approved (verbal); spec pending user review

---

## 1. Motivation

Two unrelated user-visible defects on the autoresearch dashboard, plus one structural mismatch with the meta-loop architecture introduced on this branch:

1. **Demo simulation masquerades as real progress.** When the server dies (operator Ctrl+C in the console, OOM, panic) the dashboard reconnects to the WebSocket. After 3 failed retries (~8 s after death) the browser-side `startDemo()` runs and writes "── Stage 0: … ──" … "── Stage 6: …" plus green checkmarks into the same `main` pane that mirrors real server stderr. Per-stage indicators flip from gray to green via `setStageStatus(N, 'done')`. To the operator this looks indistinguishable from a real run, but no work is happening.

2. **CLI pane no longer earns its slot.** The interactive `cli` xterm exists so the operator can run `claude login` once and any debug commands. In practice login happens at most once per machine (credentials cached in `~/.claude/.credentials.json`); afterward the bottom-half pane is dead weight that crowds out information the operator actually consults every iteration.

3. **No surface for meta-loop state.** This branch (`meta-loop-phase1`) introduces a partition of `/mnt/f/code2/target_skill/struct_layout_opt/MANIFEST.yml` into `frozen:` (never change across meta-iters) and `evolving:` (candidate prompt/inputs/lib files mutated by each meta-iter). The current dashboard has no view of which file is in which set, what changed vs. the `champion` tag, or what the winning version looks like. The operator must `cd` into the skill repo and run `git diff champion..HEAD` manually — friction that the dashboard exists to remove.

This rework addresses all three in one pass because they all rewrite the same center column of the layout, and because the post-rework structure makes the demo gate trivial.

## 2. Goals & non-goals

**Goals**

- Remove the auto-triggering demo path so a dead server never looks alive.
- Keep the demo code reachable for UI testing via an explicit `?demo=1` URL.
- Reorganize the center column so the operator sees, at a glance:
  - The current meta-iter's skill-file state (frozen / evolving-unchanged / evolving-changed / champion), and
  - The log of the stage currently running, with auto-follow when stages advance.
- Surface real version history immediately on WebSocket connect (delete the 2-second window of inline mock commits at HTML:642).

**Non-goals**

- The Stage 0 "✓ Confirm & Continue" button is purely local UI today; the server's `loopState.stages[0]` is never told. This is a separate bug; **not in scope**.
- The InteractivePty (cli pane backend) is *not* removed from the server. Future flows may still need a programmatic interactive shell. Only the dashboard's view of it is removed.
- No changes to the inner per-iter pipeline (ideate → apply → build → verify → decide). loop.ts is touched only to write per-stage logs to disk.
- No reflow of header, left panel (Skill & Scope + Setup Stages), or right panel (版本历史 + 阶段日志). Existing functionality kept verbatim.

## 3. Architecture

Three modules, deliberately decoupled so each can be reviewed/landed independently:

| Module | Files | What it owns |
|---|---|---|
| **A. Demo isolation** | `Autoresearch Dashboard.html` only | Gate `startDemo()` behind `?demo=1`; replace WS-onclose auto-trigger with a "disconnected" banner. |
| **B. Layout reorganization** | `Autoresearch Dashboard.html` (HTML + CSS); minor `web.ts` (stop broadcasting cli PTY bytes) | Delete `term-cli-wrap`, add `skill-quadrants` (top center) + `stage-log-panel` (bottom center). |
| **C. Data paths for new panels** | `autoresearch/src/loop.ts`, `autoresearch/src/web.ts`, `Autoresearch Dashboard.html` | Write per-stage logs to disk; expose `/api/stage-log` + `/api/skill-state`; render them. |

Modules A and B are pure UI; module C introduces new server endpoints and new file IO.

### 3.1 Module A — Demo isolation

**Behavior change matrix**

| Trigger | Today | After |
|---|---|---|
| Page load, server up | renders 4 inline mock commits for ~2 s, then real history overwrites | renders empty list, real history arrives in the WS handshake (see §3.3) |
| WS onclose (server died) | yellow ws-dot, polling fallback, demo starts after 3 failed reconnects | red ws-dot, polling fallback, banner "服务器已断开 — 重连中…", **no demo** |
| `http://localhost:8080/?demo=1` | n/a | full demo: 4 mock commits + full 7-stage simulation + no WS connection attempt |

**Changed code points**

- [Autoresearch Dashboard.html:642-650](../../Autoresearch Dashboard.html#L642-L650) — remove inline `renderHistory({…4 commits…})` call from normal load path. Move it inside the `?demo=1` gate.
- [Autoresearch Dashboard.html:720-733](../../Autoresearch Dashboard.html#L720-L733) — `ws.onclose`: set ws-dot to a new `.dead` class (red), label "服务器已断开 — 重连中…", keep `startPolling()` + reconnect schedule, **delete** the `if (wsReconnectAttempt === 3 && !demoRunning) startDemo();` line.
- [Autoresearch Dashboard.html:887](../../Autoresearch Dashboard.html#L887) — replace the bare `connectWS()` with:
  ```js
  if (new URLSearchParams(location.search).has('demo')) {
    renderHistory({ branch: 'main', commits: [...mockCommits] });
    document.getElementById('demo-pill').style.display = '';
    startDemo();
  } else {
    connectWS();
  }
  ```
- New header element: a hidden `<span id="demo-pill">DEMO</span>` shown only in demo mode (bright orange pill near `ws-dot`) so testers cannot confuse fake data for real.
- New CSS rule: `.ws-dot.dead { background: var(--red); }` (red dot for disconnected; keeps the existing `.demo` yellow class for the demo-only path).

### 3.2 Module B — Layout reorganization

**HTML structure (center column only)**

Before:
```html
<div id="center">
  <div class="term-wrap" id="term-main-wrap"> <!-- xterm main, loopTerm mirror --> </div>
  <div id="divider"></div>
  <div class="term-wrap" id="term-cli-wrap">  <!-- xterm cli, interactive --> </div>
</div>
```

After:
```html
<div id="center">
  <section id="skill-quadrants">                        <!-- top half -->
    <div class="quad" id="q-evolving-unchanged"> … </div>
    <div class="quad" id="q-evolving-changed">   … </div>
    <div class="quad" id="q-frozen">              … </div>
    <div class="quad" id="q-winner">              … </div>
  </section>
  <div id="divider"></div>
  <section id="stage-log-panel">                        <!-- bottom half -->
    <header>
      <select id="stage-log-sel"> <!-- stage 0..6 + "📍 follow current" --> </select>
      <span class="stage-log-meta" id="stage-log-meta"> iter — / phase — </span>
    </header>
    <pre id="stage-log-body"></pre>
  </section>
</div>
```

**CSS**

- `#skill-quadrants { display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:1px; background:var(--border); }` with the 4 children explicitly placed via `grid-area` so the visual layout matches the spec:
  - top-left: `q-evolving-unchanged`
  - top-right: `q-evolving-changed`
  - bottom-left: `q-frozen`
  - bottom-right: `q-winner`
- `.quad` is a `<div>` with `overflow-y:auto;` and a sticky header `<div class="quad-title">` that shows the category name + count.
- `#stage-log-body { font-family: monospace; white-space: pre; overflow: auto; }` — replaces xterm. ANSI escapes from underlying commands are stripped server-side before writing to disk (see §3.3) so the body is plain text.

**xterm cleanup**

- Remove `cli = makeTerm('term-cli')` and all references to `cli.term`, `cli.fit`.
- Remove the divider drag handler's `cliWrap.style.flex` line; restyle divider to resize `#skill-quadrants` vs `#stage-log-panel` instead.
- The remaining `main` xterm is also removed — `#stage-log-body` is a plain `<pre>`, not xterm. Saves ~30 KB of bundle and the `MAIN_WIDE_COLS = 240` workaround.

**Server-side companion change (web.ts):**

- Delete the `cli.on('data', …)` and `cli.on('dead', …)`, `cli.on('restarted', …)`, `cli.on('restart-failed', …)` broadcasts ([web.ts:347-359](../../autoresearch/src/web.ts#L347-L359)).
- Delete the `loopTerm.on('dead', …)` broadcast (now irrelevant — the new bottom panel reads files, not the loopTerm PTY).
- Delete the `process.stderr.write` hijacking ([web.ts:375-396](../../autoresearch/src/web.ts#L375-L396)) — no more main-pane mirror. loop.log still gets the bytes via shell stderr redirection, so debugging from the console is unaffected.
- Delete the `cli` and `main` keys from the `ptyBuf` ring buffers — no longer needed.

InteractivePty itself is kept instantiated in `index.ts`; future flows may still want a programmatic interactive shell. It just no longer streams to the dashboard.

### 3.3 Module C — data paths

#### 3.3.1 Per-stage log files

**File layout** — written by `loop.ts` into a `.ar/` subdirectory of the workdir:

```
${cfg.workdir}/.ar/stage-0.log    # Setup
${cfg.workdir}/.ar/stage-1.log    # Ideate
${cfg.workdir}/.ar/stage-2.log    # Apply
${cfg.workdir}/.ar/stage-3.log    # Build
${cfg.workdir}/.ar/stage-4.log    # Verify
${cfg.workdir}/.ar/stage-5.log    # Decide
${cfg.workdir}/.ar/stage-6.log    # Schedule
```

The directory is created once at session start (`mkdir -p .ar`) and is gitignored in the angle workdir (operator adds `.ar/` to `/home/fxy/angle/.git/info/exclude` once; documented in how-to.md).

Each stage's `.log` file is **truncated at the start of the stage**. Behavior is deliberately not append-across-iters — the bottom panel is for the *current* execution, while `loop.log` and `results.tsv` already provide cross-iter history.

**Log format** (text, no ANSI):

```
# iter 4  stage 1  begin  2026-05-14T12:30:00Z
# cmd: /mnt/f/code2/target_skill/struct_layout_opt/run.sh <<'AR_EOF_xxx'
<stdout>
<stderr>
# exit=0  duration=305240ms  end 2026-05-14T12:35:05Z
```

The `cmd:` line is the command being run (heredoc body elided). The body is `stdout + stderr` concatenated; `\r` is stripped to LF; ANSI CSI sequences are stripped via a single regex (`/\x1b\[[0-9;]*[A-Za-z]/g`) to keep `<pre>` rendering clean.

**loop.ts changes**

Introduce a helper:

```ts
async function withStageLog<T>(
  stage: number,
  iter:  number,
  cmd:   string,
  fn:    () => Promise<CmdResult>,
): Promise<CmdResult> {
  const path = join(cfg.workdir, ".ar", `stage-${stage}.log`);
  await mkdir(dirname(path), { recursive: true });
  const head = `# iter ${iter}  stage ${stage}  begin  ${new Date().toISOString()}\n# cmd: ${oneLine(cmd)}\n`;
  await writeFile(path, head);             // truncate-and-write
  const r = await fn();
  const tail = `# exit=${r.exitCode}  duration=${r.durationMs}ms  end  ${new Date().toISOString()}\n`;
  const body = stripAnsi(r.stdout + r.stderr).replace(/\r/g, "");
  await appendFile(path, body + tail);
  return r;
}
```

Wrap each stage in `runSession()`:
- Stage 0: setupCmds loop ([loop.ts:213-218](../../autoresearch/src/loop.ts#L213-L218)) — concatenate all setup cmd outputs into stage-0.log.
- Stage 1: ideate ([loop.ts:284-291](../../autoresearch/src/loop.ts#L284-L291))
- Stage 2: apply ([loop.ts:309-329](../../autoresearch/src/loop.ts#L309-L329))
- Stage 3: guard ([loop.ts:358-368](../../autoresearch/src/loop.ts#L358-L368))
- Stage 4: verify ([loop.ts:373-392](../../autoresearch/src/loop.ts#L373-L392))
- Stage 5: decide ([loop.ts:397-423](../../autoresearch/src/loop.ts#L397-L423)) — captures the keep/discard decision + git revert if any.
- Stage 6: schedule — short synthetic log: "iter N decided=keep|discard, next iter pending."

**web.ts changes**

New REST endpoint:
```
GET /api/stage-log?stage=<0..6>
  → text/plain content of .ar/stage-N.log, or 404 if missing
  → cap at 1 MB (truncate from head with a "[truncated …]" marker if larger)
```

New WS broadcast on file change:
```ts
import { watch } from "fs";
for (let i = 0; i <= 6; i++) {
  const p = join(cfg.workdir, ".ar", `stage-${i}.log`);
  watch(p, { persistent: false }, () => {
    broadcast(wss, { type: "stage-log-updated", stage: i });
  });
}
```

Browser re-fetches via REST on `stage-log-updated`. Pull-based on update notification, not push-based — avoids streaming partial frames and keeps the protocol simple.

#### 3.3.2 Target skill state (MANIFEST + diff vs champion)

**New REST endpoint:**

```
GET /api/skill-state
```

Response:
```jsonc
{
  "manifest": {
    "frozen":   ["SKILL.md", "run.sh", "lib/parse_output.py", "MANIFEST.yml"],
    "evolving": ["inputs/rules.MD", "inputs/cold_path.MD", "inputs/correlation.MD",
                 "prompt.tmpl", "lib/fuse_context.py"]
  },
  "current":  { "head": "abc1234", "tag": "skill-v2-cand" },
  "champion": { "head": "def5678", "tag": "skill-v2" },
  "diff": [
    { "path": "prompt.tmpl",        "added": 12, "removed": 3 },
    { "path": "lib/fuse_context.py", "added":  5, "removed": 1 }
  ]
}
```

**Server implementation:**

- New `getSkillState(cfg: Config): SkillStateMsg` function in `web.ts`.
- Reads `${cfg.skillDir}/MANIFEST.yml` with the existing js-yaml dep already in node_modules.
- Runs `git -C ${cfg.skillDir} diff --numstat champion..HEAD` to populate `diff[]`.
- Resolves tags via `git -C ${cfg.skillDir} tag --points-at <ref>` (skipping the rolling `champion` label, same logic meta-bench.sh already uses).
- 404 / empty manifest is tolerated: server returns `{manifest:{frozen:[],evolving:[]}, current:{head:""}, champion:{head:""}, diff:[]}` and the panel shows "No skill manifest at <path>".

**Existing config field** — `skillDir?: string` already declared at [config.ts:13](../../autoresearch/src/config.ts#L13) and set in [vk-image-helper.yml:28](../../vk-image-helper.yml#L28) (`/mnt/f/code2/target_skill/struct_layout_opt`). No yml/config schema change needed; `getSkillState()` reads `cfg.skillDir` directly. When `cfg.skillDir` is undefined, `/api/skill-state` returns `{manifest:{frozen:[],evolving:[]}, current:{head:""}, champion:{head:""}, diff:[]}` and the panel shows "skillDir not configured".

**Periodic broadcast** — server adds `getSkillState(cfg)` to the 2s status interval already in [web.ts:486-499](../../autoresearch/src/web.ts#L486-L499), and also pushes it as part of the WS handshake. Frequency is fine: MANIFEST.yml + numstat is < 5 ms even on a cold cache.

**Diff viewer for "evolving and change" quadrant**

Clicking a file row in the top-right quadrant calls:
```
GET /api/skill-diff?path=<rel-path>
  → text/plain unified diff: `git -C <skillDir> diff champion..HEAD -- <path>`
```

Rendered in a modal overlay (uses the existing toast container styles, expanded). Closing returns to the quadrant view.

**Winner viewer for "evolving winner" quadrant**

Clicking a file in the bottom-right quadrant calls:
```
GET /api/skill-show?ref=champion&path=<rel-path>
  → text/plain content of file at the champion ref: `git -C <skillDir> show champion:<path>`
```

Same modal overlay.

#### 3.3.3 Immediate history on WS handshake

Add one line to [web.ts:413-424](../../autoresearch/src/web.ts#L413-L424) (the on-connect snapshot block):

```ts
ws.send(JSON.stringify(getHistory(cfg)));
```

Eliminates the 2-second window where the right panel shows nothing (or mock commits, under module A).

## 4. Data flow

```
                ┌───────────── browser ───────────────┐
                │ skill-quadrants ◄── /api/skill-state │  poll-on-WS-tick + REST on click
                │ stage-log-panel ◄── /api/stage-log   │  WS notify "stage-log-updated" → REST fetch
                └────────────┬──────────────────▲──────┘
                             │ ws & rest        │
                ┌────────────▼──────────────────┴──────┐
                │ web.ts                                │
                │  + getSkillState()                    │
                │  + /api/stage-log, /api/skill-state,  │
                │    /api/skill-diff, /api/skill-show   │
                │  + fs.watch(.ar/stage-*.log)          │
                │  - cli/main PTY broadcasts (removed)  │
                │  - stderr.write hijack (removed)      │
                └────┬──────────────────┬───────────────┘
                     │                  │
                ┌────▼──────┐     ┌────▼─────────────┐
                │ loop.ts   │     │ skillDir         │
                │  withStageLog()  │  MANIFEST.yml   │
                │  writes .ar/stage-N.log            │
                │                  │  .git           │
                └───────────┘     └──────────────────┘
```

## 5. Error handling

- **`.ar/` directory creation fails** (read-only fs, permissions): `withStageLog` logs to stderr and returns the original `CmdResult`; the panel shows "stage-N.log unavailable" instead of crashing the loop.
- **`/api/stage-log` for a stage that hasn't run yet**: 404; panel shows "stage N not yet started in this iter".
- **`/api/skill-state` when MANIFEST.yml missing**: empty quadrants with a single "No skill manifest at <skillDir>/MANIFEST.yml" notice. Loop continues working — skill state is read-only metadata.
- **`git diff` fails** (no champion tag): empty diff array; "evolving and change" quadrant is empty; "evolving winner" quadrant shows the same files as "evolving but no change". Notice: "no champion tag in <skillDir>".
- **WebSocket dies after server starts** (this is the bug that motivated the whole spec): red banner, polling fallback already in place. No demo, no false greens.

## 6. Testing

**Manual verification** (full list duplicates the §verification block already shown to user):

1. `npx tsx src/index.ts ../vk-image-helper.yml` → open `/` → ws-dot green, no demo, history populated immediately
2. Ctrl+C server → ws-dot red, banner shown, no fake stages
3. Restart → ws-dot back to green
4. `/?demo=1` → full demo with prominent DEMO pill in header
5. Run loop → stage panel auto-follows current stage; switching to a non-current stage holds the view
6. Modify `${skillDir}/inputs/rules.MD` → file moves from "evolving but no change" to "evolving and change" within 2s tick
7. Click file in "evolving and change" → unified diff modal opens

**Automated checks** added under `autoresearch/src/tests/`:
- `stage-log.test.ts` — drive `withStageLog` with a fake CmdResult, assert file format on disk.
- `skill-state.test.ts` — fixture `MANIFEST.yml` + fixture git history, assert `getSkillState()` partitions correctly.

**Demo path coverage** — `/?demo=1` itself is the integration test for the dashboard UI shell; manual smoke test required (no headless browser in this repo yet).

## 7. Out of scope (deferred)

- **Stage 0 confirm round-trip** — server's `loopState.stages[0]` stays `'confirm'` regardless of UI click. Real fix: send `{type:'stage', stage:0, status:'done'}` from browser, handle in `web.ts` and call `setStage(0, 'done')`. Tracked separately.
- **Historical stage logs** — only "current" stage state is shown; previous iters' stage logs are not archived. Operators consult `loop.log` (the rolling per-process stderr) for cross-iter context, and `results.tsv` for outcomes. If demand emerges later, archive `.ar/stage-*.log` to `meta-runs/<iter>/` on each commit.
- **Skill state for inner-loop (vk_helpers.h/.cpp) workspace** — the 2×2 panel shows the *meta-loop* skill, not the inner-loop target source. The inner-loop diff is already on the right panel (版本历史) at the commit level. If a "current uncommitted inner-loop diff" view is wanted, that's a follow-up.

## 8. Files changed (summary)

| File | LOC delta (rough) | Nature |
|---|---|---|
| `Autoresearch Dashboard.html` | +180 / -150 | HTML restructure (center column), CSS for quadrants, JS for `/api/skill-state` + `/api/stage-log` polling, demo URL gate |
| `autoresearch/src/loop.ts` | +50 / -0 | `withStageLog` helper + 6 stage wrappers |
| `autoresearch/src/web.ts` | +120 / -60 | new endpoints + handshake history send + remove cli/main broadcasts + remove stderr mirror |
| `autoresearch/scripts/test-stage-log.ts` | new, ~80 LOC | unit test (tsx + node:assert, registered in run-all-tests.sh) |
| `autoresearch/scripts/test-skill-state.ts` | new, ~100 LOC | unit test (tsx + node:assert, registered in run-all-tests.sh) |
| `autoresearch/scripts/run-all-tests.sh` | +2 / 0 | register the 2 new suites |
| `how-to.md` | +10 / -3 | document new `.ar/` dir, `?demo=1` URL, that cli pane is gone |

Total: roughly +550 / -210 lines.

## 9. Open questions

None at design time. All ambiguities answered during brainstorming:
- Mock commits stay reachable via `?demo=1` (user clarification).
- "evolving winner" = files at `champion` git tag in skillDir (matches MANIFEST.yml + meta-bench.sh semantics).
- Historical stage logs not archived (operator can use loop.log for cross-iter context).
