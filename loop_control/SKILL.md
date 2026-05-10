---
name: loop_control
description: Use when the controlling agent (Claude / Copilot / any tool that loads SKILL.md) needs to drive the struct_cache_opt closed loop — start / stop / patch the autoresearch backend that optimises vk::ImageHelper via gfxbench gl_5_normal + perf counters. Triggers when the operator says "start the loop", "watch the autoresearch run", "the loop broke / fix it", or asks for status of the optimisation.
---

# loop_control

The agent loading this skill (Claude, Copilot, or any tool that consumes
SKILL.md) is the **supervisor** of the autoresearch closed loop. The Web UI
(`Autoresearch Dashboard.html`) is for the human operator to **observe**;
mid-loop control — patching commands, restarting after a config error,
resetting Angle to a known commit, switching the main metric — is the
agent's job.

The loop itself is run by `autoresearch/src/loop.ts` driven by
`/mnt/f/code2/struct_cache_opt/vk-image-helper.yml`. Skill that generates
diffs lives at `/mnt/f/code2/target_skill/struct_cache_opt`. Workdir is
`/home/fxy/angle`.

This is a **flexible** skill: adapt the order of steps to context, but never
weaken the boundaries below.

---

## Boundaries

The agent may freely:

- Start / stop / restart the backend process.
- Edit `vk-image-helper.yml` (skill path, contextCmds, setupCmds, guardCmd,
  verifyCmd, diagCmd, direction, metricLabel, iterations, plateauPatience).
- Edit the diff-generating skill's `prompt.tmpl` /
  `pahole-image-helper.sh` (committing the change in
  `/mnt/f/code2/target_skill/.git`).
- `tail -F` log files; parse `results.tsv` and `git log` in the workdir.
- Send WebSocket commands to `ws://localhost:8080` to start / stop / apply
  a commit / toggle dry-run.

The agent must confirm with the operator before:

- `git reset --hard` in `/home/fxy/angle` (rewrites their working tree).
- Force-pushing or amending commits the operator personally authored.
- Installing system packages (perf, jq, kernel modules).
- Spending significant LLM credit (>50 ideate iterations).

The agent must never:

- Remove `/home/fxy/angle/.git` or `/mnt/f/code2/target_skill/.git`.
- `git push` to any remote.
- Disable the scope guard or commit out-of-scope edits.

---

## Quick reference

| Thing | Path / command |
|---|---|
| Backend entry | `cd /mnt/f/code2/struct_cache_opt/autoresearch && npx tsx src/index.ts ../vk-image-helper.yml` |
| PID file | `/mnt/f/code2/struct_cache_opt/loop.pid` (the agent creates it) |
| Backend stderr | `/mnt/f/code2/struct_cache_opt/loop.log` (tail target) |
| Per-iter logs | `${workdir}/stage-{0..6}.log`, `build.log`, `$AR_PERF_LOG` (`/tmp/ar-perf.log`) |
| Iteration history | `/mnt/f/code2/struct_cache_opt/results.tsv` |
| WebSocket | `ws://localhost:8080` (real-time push) |
| HTTP polling fallback | `GET http://localhost:8080/api/state` → JSON snapshot of status/git/history/logs/pty buffers. Use when WS is blocked (corporate proxy, VS Code Simple Browser). The agent can drive the loop entirely through this endpoint plus the WebSocket message types listed below — no UI required. |
| Dashboard | `Autoresearch Dashboard.html` (open in browser; auto-falls back to /api/state when WS dies) |
| Diff-generating skill | `/mnt/f/code2/target_skill/struct_cache_opt/SKILL.md` |
| Auto-versioned skill repo | `/mnt/f/code2/target_skill/.git` (commit after editing prompt.tmpl etc.) |

---

## Start procedure

1. Sanity check the environment first — saves a wasted iteration:

   ```bash
   command -v jq perf node tsx
   test -d /home/fxy/angle/.git           && echo angle_repo_ok
   test -d /mnt/f/code2/target_skill/.git && echo skill_repo_ok
   test -x /home/fxy/work/gfxbench/tfw-pkg/bin/testfw_app && echo gfxbench_ok
   perf stat -e cycles true 2>&1 | tail -3      # WSL2: may say "perf not found"
   ```

   If `perf` is broken on WSL2 (`perf not found for kernel ...`), tell the
   operator:
   > `perf stat` won't run here — install `linux-tools-standard-WSL2` or
   > move to a real Linux host. The verifyCmd will fail until then. Want me
   > to switch to fps-only mode in the meantime?

   If they accept fps-only: edit yml, set `direction: higher`,
   `metricLabel: fps`, `verifyCmd` ends with `echo "$fps"`.

2. Start the backend in the background and capture its PID:

   ```bash
   cd /mnt/f/code2/struct_cache_opt/autoresearch
   nohup npx tsx src/index.ts ../vk-image-helper.yml \
       > /dev/null 2> /mnt/f/code2/struct_cache_opt/loop.log &
   echo $! > /mnt/f/code2/struct_cache_opt/loop.pid
   ```

3. Wait until `loop.log` prints `awaiting Start signal from dashboard…`,
   then tell the operator to:
   - Open `Autoresearch Dashboard.html`.
   - In the main terminal, run `claude login` (or whatever auth the
     configured `IDEATE_CLI` requires).
   - Click ✓ Confirm on Stage 0, then ▶ Start.

   The agent does not click Start itself unless the operator explicitly
   asks ("start automatically" / "go").

---

## Watch loop (after Start)

Tail `loop.log` in the background. Each iteration now prints per-stage lines:

```
[autoresearch] ── iter N ──
[iter N] stage 1: ideate (/path/to/run.sh)
[iter N] stage 1: ideate exit=0 stdout=845B stderr=0B (305240ms)
[iter N] stage 2: git apply (845B patch)
[iter N] stage 2: apply OK
[iter N] stage 3: guardCmd (build)
[iter N] stage 3: build exit=0 (118000ms)
[iter N] stage 4: verifyCmd (metric)
[iter N] stage 4: verify exit=0 metric=1119914 stdout="1119914" (5200ms)
[autoresearch] ✓ keep  metric=12345  delta=-678
```

When a stage FAILs the log includes a 5-line preview of stdout + stderr,
plus (for apply-fail) the first/last 5 lines of the rejected patch and
(for build/verify-fail) the diagCmd's first hint. Cross-check
`results.tsv` for the canonical row. Server-side `[web] WS connect / close`
lines tell you whether the dashboard is actually attached. Relevant fields:

| Column | Meaning |
|---|---|
| iter | iteration number (0 = baseline) |
| status | baseline / keep / discard / no-op / crash / dry-run |
| metric | cache-misses (lower is better) |
| delta | metric − prev_best (negative = improvement) |
| desc | reason: keep / regress / build-fail / verify-bad / out-of-scope / ... |

`results.tsv` is append-only and survives restarts; `bestSoFar()` recovers
state from it.

---

## Failure handling

For each `desc` value, do this:

| desc | Inspect | Likely fix |
|---|---|---|
| `ideate-fail` | `tail -100 stage-1.log`; check the LLM CLI auth | restart the CLI auth in the cli PTY; if context too large, lower `memoryDepth` in yml |
| `apply-fail` | `git -C /home/fxy/angle status`, `cat .ar.patch` | usually base drift; ask operator before `git reset --hard <last-keep-hash>` |
| `out-of-scope` | `git diff --name-only` (already reverted) | tighten `prompt.tmpl` to remind the LLM about scope |
| `build-fail` | `tail -50 /home/fxy/angle/build.log`; `diagCmd` already extracted top errors into TSV `desc` | if it's a syntax error from the diff → next iter naturally fixes it; if recurring → improve `prompt.tmpl` |
| `verify-bad` | `tail -50 $AR_PERF_LOG`; `ls -t /home/fxy/work/gfxbench/tfw-pkg/results/` | gfxbench crashed → revert already done; if perf broken → see "perf-broken" below |
| `regress` | none | normal; the LLM will see this in next iter's git log body |

### perf-broken
If 3 consecutive iters fail `verify-bad` AND `$AR_PERF_LOG` is empty or
contains "perf not found":

1. Stop the loop (`kill $(cat loop.pid)` or `{type:"loop",action:"stop"}`).
2. Edit yml: comment out the `perf stat` wrapper and switch to fps-only.
3. Tell the operator what you changed and why; restart.

### Mid-run config patch
The backend reads yml only on process start. To change a command mid-run:

```bash
# 1. Stop
kill $(cat /mnt/f/code2/struct_cache_opt/loop.pid)
# 2. Edit yml
# 3. Restart — same command as Start procedure step 2
```

History is preserved across restarts via `results.tsv` and the workdir's
git log; do not delete either.

### Editing the diff-generating skill
After modifying `prompt.tmpl`, `pahole-image-helper.sh`, or `run.sh`,
commit in the skill repo so the change is timestamped and revertible:

```bash
git -C /mnt/f/code2/target_skill add -A
git -C /mnt/f/code2/target_skill -c user.email=autoresearch@local \
    -c user.name=autoresearch commit -m "skill: <what changed>  (iter N)"
```

This is what "auto-versioning the target skill" means — every prompt
revision lives next to the experiment results it influenced.

---

## Driving via WebSocket / HTTP (no UI clicks)

The agent can drive the loop without any browser. Two paths:

### A. WebSocket commands (push-style)

```bash
# install once (or use the bundled `ws` module via a one-liner node script)
npm i -g wscat
# start
wscat -c ws://localhost:8080 -x '{"type":"loop","action":"start"}'
# stop
wscat -c ws://localhost:8080 -x '{"type":"loop","action":"stop"}'
# toggle dry-run
wscat -c ws://localhost:8080 -x '{"type":"config","dryRun":true}'
# reset workdir to a commit
wscat -c ws://localhost:8080 -x '{"type":"apply","hash":"abcd1234"}'
```

If `wscat` isn't installed and you don't want to install it, use the
`ws` module that already ships with autoresearch:

```bash
/home/fxy/.nvm/versions/node/v22.22.1/bin/node -e "
const W=require('/mnt/f/code2/struct_cache_opt/autoresearch/node_modules/ws');
const ws=new W('ws://localhost:8080');
ws.on('open',()=>{ws.send(JSON.stringify({type:'loop',action:'start',iterations:2}));setTimeout(()=>process.exit(0),500);});"
```

### B. HTTP polling (pull-style, proxy-friendly)

Single endpoint returning everything the dashboard needs:

```bash
curl -s --noproxy '*' http://127.0.0.1:8080/api/state | jq .
```

Payload shape:
```
{
  "status":  { "iter":N, "total":N, "phase":"...", "best":N, "alive":bool },
  "git":     { "branch":..., "lastCommit":..., "changed":[...] },
  "logs":    { "files":[{label,path,size,exists}, ...] },
  "history": { "commits":[{hash,iter,subject,status,metric,delta,files,...}], "head":"..." },
  "pty":     { "main":"...", "cli":"..." }    // ring buffer (last 64KB)
}
```

The agent uses /api/state when the loop's PTY is hung in a way the
WebSocket events can't surface (e.g. PTY frozen → no `[autoresearch]` lines
on stderr, but ptyBuf still shows the last bytes the PTY emitted before
freezing).

Stage 0 is `confirm` — manual auth is unavoidable; the operator must have
run the IDEATE_CLI's auth command in the main PTY at least once before the
session can advance past Stage 0. (If the IDEATE_CLI is `claude -p` and
`~/.claude/.credentials.json` already exists from a prior session, the
auth requirement is satisfied transparently.)

---

## End of session

```bash
kill $(cat /mnt/f/code2/struct_cache_opt/loop.pid)
rm /mnt/f/code2/struct_cache_opt/loop.pid
```

Then summarise to the operator:

- Total iterations, keeps, best metric, best commit hash.
- Any config changes the agent made and why.
- If skill files were edited, the commit hash in `/mnt/f/code2/target_skill`.
