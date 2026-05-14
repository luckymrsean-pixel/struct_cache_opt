# Dashboard Meta-Loop Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's broken demo-on-disconnect behavior and the unused cli pane with a meta-loop-aware center column (skill quadrants on top, stage log viewer on bottom), backed by new server endpoints that read `.ar/stage-N.log` files and `MANIFEST.yml` + git state in the skillDir.

**Architecture:** Three decoupled modules implemented bottom-up — first server-side data sources (per-stage logs, skill-state endpoints), then UI wiring, finally demo isolation. Each task lands a self-contained, testable change. Browser test for the UI happens manually after each UI task.

**Tech Stack:** TypeScript (`tsx` runtime, no compilation), Node 22, `ws` v8, `yaml` v2, `node-pty`, `node:assert` for tests, plain HTML/CSS/JS for the dashboard (no build step).

**Spec:** [docs/superpowers/specs/2026-05-14-dashboard-meta-rework-design.md](../specs/2026-05-14-dashboard-meta-rework-design.md)

---

## File map

**Server (autoresearch/src/):**

| File | Status | Responsibility |
|---|---|---|
| `loop.ts` | modify | Add `withStageLog` helper + wrap each stage so it writes `${workdir}/.ar/stage-N.log` |
| `web.ts` | modify | Add `/api/stage-log`, `/api/skill-state`, `/api/skill-diff`, `/api/skill-show`; broadcast `stage-log-updated` on fs.watch; send `history` in WS handshake; remove cli-broadcast + stderr-mirror |
| `skill_state.ts` | **new** | Pure functions: `readManifest()`, `getSkillState()`, `getSkillDiff()`, `getSkillShow()`. Split out so it's unit-testable without spinning up an http server. |
| `stage_log.ts` | **new** | Pure functions: `stageLogPath()`, `writeStageLogHead()`, `writeStageLogTail()`, `stripAnsi()`. Used by `loop.ts` and `web.ts`. |
| `config.ts` | unchanged | `skillDir?: string` already present |
| `index.ts` | unchanged | InteractivePty stays instantiated (server-side only now) |

**Tests (autoresearch/scripts/):**

| File | Status | Responsibility |
|---|---|---|
| `test-stage-log.ts` | **new** | Unit-test `stageLogPath/writeStageLogHead/writeStageLogTail/stripAnsi` on tmp dir |
| `test-skill-state.ts` | **new** | Unit-test `readManifest/getSkillState/getSkillDiff` using a temp git repo fixture |
| `run-all-tests.sh` | modify | Register the 2 new suites |

**Dashboard:**

| File | Status | Responsibility |
|---|---|---|
| `Autoresearch Dashboard.html` | modify | Layout swap (delete cli pane, add quadrants + log panel), demo `?demo=1` gate, red disconnected banner |

**Docs:**

| File | Status | Responsibility |
|---|---|---|
| `how-to.md` | modify | Document `.ar/` dir, `?demo=1` URL, cli-pane removal |

---

## Task ordering rationale

Server first so the UI has real data to render. Within server, pure helpers (`stage_log.ts`, `skill_state.ts`) before integration into `loop.ts` / `web.ts` — keeps test surface small. UI tasks land after their data dependencies. Demo isolation is last because the layout removal already eliminates most of the surface that demo writes to.

---

## Task 1: Extract `stage_log.ts` pure helpers

**Files:**
- Create: `autoresearch/src/stage_log.ts`
- Create: `autoresearch/scripts/test-stage-log.ts`
- Modify: `autoresearch/scripts/run-all-tests.sh:24`

- [ ] **Step 1: Write the failing test**

Create `autoresearch/scripts/test-stage-log.ts`:

```ts
/**
 * Unit tests for stage_log helpers — pure file I/O + ANSI stripping.
 * Run: tsx scripts/test-stage-log.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  stageLogPath,
  writeStageLogHead,
  writeStageLogTail,
  stripAnsi,
} from "../src/stage_log";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗  ${name}\n     ${msg}`);
    failed++;
  }
}

function eq<T>(label: string, got: T, want: T): void {
  if (got !== want)
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const workdir = mkdtempSync(join(tmpdir(), "ar-stage-log-"));

test("stageLogPath resolves under <workdir>/.ar", () => {
  eq("path", stageLogPath(workdir, 3), join(workdir, ".ar", "stage-3.log"));
});

test("stripAnsi removes CSI sequences", () => {
  eq("plain", stripAnsi("hello"), "hello");
  eq("color", stripAnsi("\x1b[32mok\x1b[0m"), "ok");
  eq("cursor", stripAnsi("\x1b[2K\x1b[1Adone"), "done");
});

test("stripAnsi normalizes CRLF and CR to LF", () => {
  eq("crlf", stripAnsi("a\r\nb"), "a\nb");
  eq("cr",   stripAnsi("a\rb"),   "a\nb");
});

test("writeStageLogHead creates .ar/ and truncates", async () => {
  await writeStageLogHead(workdir, 4, 7, "/bin/echo hi");
  const p = stageLogPath(workdir, 4);
  if (!existsSync(p)) throw new Error("file not created");
  const body = readFileSync(p, "utf8");
  if (!body.startsWith("# iter 7  stage 4  begin")) throw new Error(`head wrong: ${body.slice(0, 80)}`);
  if (!body.includes("# cmd: /bin/echo hi")) throw new Error("cmd line missing");

  // Re-call should truncate, not append
  await writeStageLogHead(workdir, 4, 8, "/bin/true");
  const after = readFileSync(p, "utf8");
  if (after.includes("iter 7")) throw new Error("did not truncate previous iter");
});

test("writeStageLogTail appends body + footer", async () => {
  await writeStageLogHead(workdir, 5, 1, "cmd-a");
  await writeStageLogTail(workdir, 5, {
    stdout: "line one\n",
    stderr: "warn\x1b[31m err\x1b[0m\n",
    exitCode: 0,
    durationMs: 1234,
  });
  const body = readFileSync(stageLogPath(workdir, 5), "utf8");
  if (!body.includes("line one\n")) throw new Error("stdout missing");
  if (!body.includes("warn err\n")) throw new Error(`stderr not ansi-stripped: ${body}`);
  if (!body.match(/# exit=0  duration=1234ms  end/)) throw new Error(`footer missing: ${body}`);
});

rmSync(workdir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
tsx scripts/test-stage-log.ts
```

Expected: `Cannot find module '../src/stage_log'` — module doesn't exist yet.

- [ ] **Step 3: Implement `stage_log.ts`**

Create `autoresearch/src/stage_log.ts`:

```ts
import { mkdir, writeFile, appendFile } from "fs/promises";
import { join, dirname } from "path";

export function stageLogPath(workdir: string, stage: number): string {
  return join(workdir, ".ar", `stage-${stage}.log`);
}

/**
 * Strip ANSI CSI escape sequences and normalize CR/CRLF to LF.
 * Used to keep .ar/stage-N.log files plain-text so the browser's <pre>
 * renderer doesn't need a terminal emulator.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
}

export async function writeStageLogHead(
  workdir: string,
  stage:   number,
  iter:    number,
  cmd:     string,
): Promise<void> {
  const path = stageLogPath(workdir, stage);
  await mkdir(dirname(path), { recursive: true });
  const oneLine = cmd.replace(/\n/g, " ⏎ ").slice(0, 300);
  const head =
    `# iter ${iter}  stage ${stage}  begin  ${new Date().toISOString()}\n` +
    `# cmd: ${oneLine}\n`;
  await writeFile(path, head, "utf8");
}

interface StageResult {
  stdout:     string;
  stderr:     string;
  exitCode:   number;
  durationMs: number;
}

export async function writeStageLogTail(
  workdir: string,
  stage:   number,
  r:       StageResult,
): Promise<void> {
  const path = stageLogPath(workdir, stage);
  const body = stripAnsi(r.stdout) + stripAnsi(r.stderr);
  const tail =
    `# exit=${r.exitCode}  duration=${r.durationMs}ms  end  ${new Date().toISOString()}\n`;
  await appendFile(path, body + tail, "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
tsx scripts/test-stage-log.ts
```

Expected: `5 passed, 0 failed`, exit 0.

- [ ] **Step 5: Register the suite in run-all-tests.sh**

Modify `autoresearch/scripts/run-all-tests.sh`. Find the line:

```bash
run_suite "M4  errors"   "tsx scripts/test-errors.ts"
```

Add right after it:

```bash
run_suite "M5  stage-log" "tsx scripts/test-stage-log.ts"
```

- [ ] **Step 6: Run full suite to confirm no regressions**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npm test
```

Expected: All 5 suites pass.

- [ ] **Step 7: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add autoresearch/src/stage_log.ts autoresearch/scripts/test-stage-log.ts autoresearch/scripts/run-all-tests.sh
git commit -m "feat(autoresearch): add stage_log helpers + unit tests"
```

---

## Task 2: Wire `withStageLog` into `loop.ts`

**Files:**
- Modify: `autoresearch/src/loop.ts:1-3` (imports)
- Modify: `autoresearch/src/loop.ts:207-218` (setup, stage 0)
- Modify: `autoresearch/src/loop.ts:280-303` (stage 1 ideate)
- Modify: `autoresearch/src/loop.ts:307-329` (stage 2 apply)
- Modify: `autoresearch/src/loop.ts:355-368` (stage 3 build)
- Modify: `autoresearch/src/loop.ts:371-392` (stage 4 verify)
- Modify: `autoresearch/src/loop.ts:397-424` (stage 5 decide + stage 6)

- [ ] **Step 1: Add the imports + a local helper**

In `autoresearch/src/loop.ts`, replace the top imports:

```ts
import { Terminal, CmdResult } from "./terminal";
import { ensure, append, tail, bestSoFar, Row } from "./logger";
import { Config } from "./config";
import { loopState, setStage, resetIterStages } from "./web";
```

with:

```ts
import { Terminal, CmdResult } from "./terminal";
import { ensure, append, tail, bestSoFar, Row } from "./logger";
import { Config } from "./config";
import { loopState, setStage, resetIterStages } from "./web";
import { writeStageLogHead, writeStageLogTail } from "./stage_log";
```

Add this helper right above the `runOrDie` definition (around line 86):

```ts
/**
 * Run `cmd` through the terminal AND mirror stdout/stderr to
 * `${workdir}/.ar/stage-<stage>.log`. Truncate on entry, append result + footer
 * on exit. Errors in the log writer are swallowed (logged to stderr) so they
 * never fail the loop.
 */
async function runWithStageLog(
  term:    Terminal,
  workdir: string,
  stage:   number,
  iter:    number,
  cmd:     string,
  timeoutMs?: number,
): Promise<CmdResult> {
  try { await writeStageLogHead(workdir, stage, iter, cmd); }
  catch (e) { console.error(`[stage-log] head ${stage} failed:`, e); }
  const r = await term.run(cmd, timeoutMs);
  try { await writeStageLogTail(workdir, stage, r); }
  catch (e) { console.error(`[stage-log] tail ${stage} failed:`, e); }
  return r;
}
```

- [ ] **Step 2: Wrap stage 0 (setupCmds)**

Replace [autoresearch/src/loop.ts:213-218](../../autoresearch/src/loop.ts#L213-L218):

```ts
  setStage(0, "running");
  for (const cmd of cfg.setupCmds ?? []) {
    console.error(`[autoresearch] setup: ${cmd}`);
    await runOrDie(term, cmd);
  }
  setStage(0, "done");
```

with:

```ts
  setStage(0, "running");
  // Stage 0 is a sequence of setupCmds; emit one combined log so the dashboard
  // can show all setup output. The file is truncated on entry and rewritten in
  // place per setup batch, which matches Stage 0's "runs once per session" role.
  try { await writeStageLogHead(cfg.workdir, 0, 0, `setupCmds (${cfg.setupCmds?.length ?? 0})`); }
  catch (e) { console.error(`[stage-log] head 0 failed:`, e); }
  for (const cmd of cfg.setupCmds ?? []) {
    console.error(`[autoresearch] setup: ${cmd}`);
    const r = await term.run(cmd);
    try { await writeStageLogTail(cfg.workdir, 0, {
      stdout: `$ ${cmd}\n${r.stdout}`,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    }); }
    catch (e) { console.error(`[stage-log] tail 0 failed:`, e); }
    if (r.exitCode !== 0) {
      throw new Error(`runOrDie: exit ${r.exitCode}\ncmd: ${cmd}\nstderr: ${r.stderr}`);
    }
  }
  setStage(0, "done");
```

(The expansion is needed because the original loop used `runOrDie` which throws on non-zero exit; we want the log written before throwing.)

- [ ] **Step 3: Wrap stage 1 (ideate)**

In `autoresearch/src/loop.ts`, find the ideate block (search for `loopState.phase = \`iter ${n}: stage 1 (ideate)\``). Replace:

```ts
    const ideate = await term.run(
      `${ideateCmd} <<'${heredocTag}'\n${ctxBody}\n${heredocTag}`,
      20 * 60_000,
    );
```

with:

```ts
    const ideate = await runWithStageLog(
      term, cfg.workdir, 1, n,
      `${ideateCmd} <<'${heredocTag}'\n${ctxBody}\n${heredocTag}`,
      20 * 60_000,
    );
```

- [ ] **Step 4: Wrap stage 2 (apply)**

Find:

```ts
    const apply = await term.run(
      `cat > .ar.patch <<'${patchTag}'\n${ideate.stdout}\n${patchTag}\n` +
      `git apply --check .ar.patch && git apply .ar.patch`,
    );
```

Replace with:

```ts
    const apply = await runWithStageLog(
      term, cfg.workdir, 2, n,
      `cat > .ar.patch <<'${patchTag}'\n${ideate.stdout}\n${patchTag}\n` +
      `git apply --check .ar.patch && git apply .ar.patch`,
    );
```

- [ ] **Step 5: Wrap stage 3 (guard/build)**

Find:

```ts
    const guard = await term.run(cfg.guardCmd, 20 * 60_000);
```

Replace with:

```ts
    const guard = await runWithStageLog(term, cfg.workdir, 3, n, cfg.guardCmd, 20 * 60_000);
```

- [ ] **Step 6: Wrap stage 4 (verify)**

Find:

```ts
    const v      = await term.run(cfg.verifyCmd, 30 * 60_000);
```

Replace with:

```ts
    const v      = await runWithStageLog(term, cfg.workdir, 4, n, cfg.verifyCmd, 30 * 60_000);
```

- [ ] **Step 7: Add stage 5 + stage 6 synthetic logs**

The decide block (loop.ts:397-424) doesn't run a shell command — it's pure JS decision logic. Synthesize a stage-5 log with the decision result. After the existing block that emits `"[autoresearch] ✓ keep"` or `"[autoresearch] ✗ discard"`, immediately before `setStage(6, "done");`, append:

Find the existing structure:

```ts
    if (better) {
      const delta = metric - best!;
      best        = metric;
      sinceBest   = 0;
      console.error(`[autoresearch] ✓ keep  metric=${metric}  delta=${delta}`);
      append(cfg.tsvPath, makeRow(n, "keep", metric, delta, v, "keep"));
      setStage(5, "done");
    } else {
      await term.run("git revert --no-edit HEAD");
      sinceBest++;
      console.error(`[autoresearch] ✗ discard  metric=${metric}  best=${best}`);
      append(cfg.tsvPath, makeRow(n, "discard", metric, metric - best!, v, "regress"));
      setStage(5, "done");
    }
    setStage(6, "done");
```

Replace with:

```ts
    let decisionStdout = "";
    if (better) {
      const delta = metric - best!;
      best        = metric;
      sinceBest   = 0;
      console.error(`[autoresearch] ✓ keep  metric=${metric}  delta=${delta}`);
      append(cfg.tsvPath, makeRow(n, "keep", metric, delta, v, "keep"));
      setStage(5, "done");
      decisionStdout = `decision: keep\nmetric: ${metric}\ndelta: ${delta}\nbest: ${best}\n`;
    } else {
      await term.run("git revert --no-edit HEAD");
      sinceBest++;
      console.error(`[autoresearch] ✗ discard  metric=${metric}  best=${best}`);
      append(cfg.tsvPath, makeRow(n, "discard", metric, metric - best!, v, "regress"));
      setStage(5, "done");
      decisionStdout = `decision: discard (regressed)\nmetric: ${metric}\nbest: ${best}\nreverted: HEAD\n`;
    }
    // Synthesize stage-5 and stage-6 logs so the dashboard's bottom panel
    // has something to show when the operator selects these stages.
    try {
      await writeStageLogHead(cfg.workdir, 5, n, "decide (keep|discard)");
      await writeStageLogTail(cfg.workdir, 5, {
        stdout: decisionStdout, stderr: "", exitCode: 0, durationMs: 0,
      });
      await writeStageLogHead(cfg.workdir, 6, n, "schedule next");
      await writeStageLogTail(cfg.workdir, 6, {
        stdout: `iter ${n} complete. sinceBest=${sinceBest}/${cfg.plateauPatience}\n` +
                `next iter: ${n + 1 <= iters ? n + 1 : "(end of run)"}\n`,
        stderr: "", exitCode: 0, durationMs: 0,
      });
    } catch (e) { console.error(`[stage-log] decide/schedule failed:`, e); }
    setStage(6, "done");
```

- [ ] **Step 8: Manual integration check**

Start the server in dry-run-friendly mode (need a fake patch in /tmp first):

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
# Ensure the dry-run patch fixture exists (1-line no-op diff is fine for now)
ls /tmp/struct_cache_opt.fake.patch  # if missing, skip this and use a real run

# Build (type check)
npm run build
```

Expected: tsc passes with 0 errors.

If you have time and a working ANGLE setup, start the server, click Start, watch:

```bash
ls -la /home/fxy/angle/.ar/
```

Expected: `stage-0.log` through `stage-5.log` populate as the loop advances.

- [ ] **Step 9: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add autoresearch/src/loop.ts
git commit -m "feat(loop): write .ar/stage-N.log for every stage"
```

---

## Task 3: Extract `skill_state.ts` pure helpers

**Files:**
- Create: `autoresearch/src/skill_state.ts`
- Create: `autoresearch/scripts/test-skill-state.ts`
- Modify: `autoresearch/scripts/run-all-tests.sh`

- [ ] **Step 1: Write the failing test**

Create `autoresearch/scripts/test-skill-state.ts`:

```ts
/**
 * Unit tests for skill_state helpers — MANIFEST.yml parsing + git diff stats.
 * Builds a tiny throwaway git repo so the test doesn't depend on the real
 * target_skill repo state.
 * Run: tsx scripts/test-skill-state.ts
 */

import { execSync } from "child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readManifest,
  getSkillState,
  getSkillDiff,
  getSkillShow,
} from "../src/skill_state";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗  ${name}\n     ${msg}`);
    failed++;
  }
}

function deepEq(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${label}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

// ── Fixture ──────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "ar-skill-state-"));

writeFileSync(join(dir, "MANIFEST.yml"),
  "frozen:\n  - SKILL.md\n  - run.sh\n" +
  "evolving:\n  - prompt.tmpl\n  - inputs/rules.MD\n",
);
mkdirSync(join(dir, "inputs"), { recursive: true });
writeFileSync(join(dir, "SKILL.md"),         "frozen header\n");
writeFileSync(join(dir, "run.sh"),           "#!/bin/sh\necho 1\n");
writeFileSync(join(dir, "prompt.tmpl"),      "v1 prompt\n");
writeFileSync(join(dir, "inputs/rules.MD"),  "v1 rules\n");

const G = (cmd: string) => execSync(cmd, { cwd: dir, encoding: "utf8" }).trim();
G("git init -q");
G("git -c user.email=t@t -c user.name=t add -A");
G("git -c user.email=t@t -c user.name=t commit -q -m initial");
G("git tag champion");
const championSha = G("git rev-parse --short HEAD");

writeFileSync(join(dir, "prompt.tmpl"), "v2 prompt\nmore\nmuch more\n");
G("git -c user.email=t@t -c user.name=t add -A");
G("git -c user.email=t@t -c user.name=t commit -q -m candidate");
const headSha = G("git rev-parse --short HEAD");

// ── Tests ────────────────────────────────────────────────────────────────────

test("readManifest parses frozen + evolving", () => {
  const m = readManifest(dir);
  deepEq("frozen",   m.frozen,   ["SKILL.md", "run.sh"]);
  deepEq("evolving", m.evolving, ["prompt.tmpl", "inputs/rules.MD"]);
});

test("getSkillState partitions correctly", () => {
  const s = getSkillState(dir);
  deepEq("manifest.frozen",   s.manifest.frozen,   ["SKILL.md", "run.sh"]);
  deepEq("manifest.evolving", s.manifest.evolving, ["prompt.tmpl", "inputs/rules.MD"]);
  // current head differs from champion
  if (s.current.head !== headSha)          throw new Error(`current head ${s.current.head} != ${headSha}`);
  if (s.champion.head !== championSha)     throw new Error(`champion head ${s.champion.head} != ${championSha}`);
  // diff should list prompt.tmpl only
  if (s.diff.length !== 1)                 throw new Error(`diff length ${s.diff.length}`);
  if (s.diff[0].path !== "prompt.tmpl")    throw new Error(`diff path ${s.diff[0].path}`);
  if (s.diff[0].added !== 3)               throw new Error(`diff added ${s.diff[0].added}`);
  if (s.diff[0].removed !== 1)             throw new Error(`diff removed ${s.diff[0].removed}`);
});

test("getSkillDiff returns unified diff", () => {
  const d = getSkillDiff(dir, "prompt.tmpl");
  if (!d.includes("-v1 prompt")) throw new Error(`expected -v1 prompt in:\n${d}`);
  if (!d.includes("+v2 prompt")) throw new Error(`expected +v2 prompt in:\n${d}`);
});

test("getSkillShow returns champion-tag content", () => {
  const c = getSkillShow(dir, "champion", "prompt.tmpl");
  if (c.trim() !== "v1 prompt") throw new Error(`expected v1 prompt, got: ${JSON.stringify(c)}`);
});

test("getSkillState handles missing skillDir gracefully", () => {
  const s = getSkillState(undefined);
  deepEq("frozen",   s.manifest.frozen,   []);
  deepEq("evolving", s.manifest.evolving, []);
  deepEq("diff",     s.diff,              []);
});

test("getSkillState handles dir without MANIFEST.yml", () => {
  const empty = mkdtempSync(join(tmpdir(), "ar-empty-"));
  execSync("git init -q", { cwd: empty });
  const s = getSkillState(empty);
  deepEq("frozen",   s.manifest.frozen,   []);
  deepEq("evolving", s.manifest.evolving, []);
  rmSync(empty, { recursive: true, force: true });
});

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
tsx scripts/test-skill-state.ts
```

Expected: `Cannot find module '../src/skill_state'`.

- [ ] **Step 3: Implement `skill_state.ts`**

Create `autoresearch/src/skill_state.ts`:

```ts
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

export interface Manifest {
  frozen:   string[];
  evolving: string[];
}

export interface DiffEntry {
  path:    string;
  added:   number;
  removed: number;
}

export interface SkillState {
  manifest: Manifest;
  current:  { head: string; tag: string };
  champion: { head: string; tag: string };
  diff:     DiffEntry[];
}

const EMPTY: SkillState = {
  manifest: { frozen: [], evolving: [] },
  current:  { head: "", tag: "" },
  champion: { head: "", tag: "" },
  diff:     [],
};

/** Run `git` in the given dir, return stdout trimmed, or `""` on any failure. */
function git(dir: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Parse MANIFEST.yml. Returns {frozen:[], evolving:[]} if missing/malformed. */
export function readManifest(skillDir: string): Manifest {
  const p = join(skillDir, "MANIFEST.yml");
  if (!existsSync(p)) return { frozen: [], evolving: [] };
  try {
    const raw = parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const norm = (arr: unknown): string[] =>
      Array.isArray(arr) ? arr.filter((x) => typeof x === "string") as string[] : [];
    return {
      frozen:   norm(raw.frozen),
      evolving: norm(raw.evolving),
    };
  } catch {
    return { frozen: [], evolving: [] };
  }
}

/** Resolve a ref to a (head-sha, tag) pair. Tag skips the rolling "champion" alias. */
function resolveRef(dir: string, ref: string): { head: string; tag: string } {
  const head = git(dir, ["rev-parse", "--short", ref]);
  const tags = git(dir, ["tag", "--points-at", ref]).split("\n").filter(Boolean);
  const tag  = tags.find((t) => t !== "champion") ?? "";
  return { head, tag };
}

/** Parse `git diff --numstat` output into DiffEntry[]. */
function parseNumstat(raw: string): DiffEntry[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, r, p] = line.split("\t");
      return {
        path:    p ?? "",
        added:   Number(a) || 0,
        removed: Number(r) || 0,
      };
    })
    .filter((e) => e.path);
}

export function getSkillState(skillDir: string | undefined): SkillState {
  if (!skillDir || !existsSync(skillDir)) return EMPTY;
  const manifest = readManifest(skillDir);
  const current  = resolveRef(skillDir, "HEAD");
  const champion = git(skillDir, ["rev-parse", "--verify", "champion"])
    ? resolveRef(skillDir, "champion")
    : { head: "", tag: "" };
  const diff = champion.head
    ? parseNumstat(git(skillDir, ["diff", "--numstat", "champion..HEAD"]))
    : [];
  return { manifest, current, champion, diff };
}

/** Unified diff for one file vs champion. Empty string if anything fails. */
export function getSkillDiff(skillDir: string, path: string): string {
  return git(skillDir, ["diff", "champion..HEAD", "--", path]);
}

/** File contents at the given ref. Empty string if anything fails. */
export function getSkillShow(skillDir: string, ref: string, path: string): string {
  return git(skillDir, ["show", `${ref}:${path}`]);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
tsx scripts/test-skill-state.ts
```

Expected: `6 passed, 0 failed`, exit 0.

- [ ] **Step 5: Register in run-all-tests.sh**

In `autoresearch/scripts/run-all-tests.sh`, after the `M5  stage-log` line from Task 1, append:

```bash
run_suite "M6  skill-state" "tsx scripts/test-skill-state.ts"
```

- [ ] **Step 6: Run full suite**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npm test
```

Expected: All 6 suites pass.

- [ ] **Step 7: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add autoresearch/src/skill_state.ts autoresearch/scripts/test-skill-state.ts autoresearch/scripts/run-all-tests.sh
git commit -m "feat(autoresearch): add skill_state helpers + unit tests"
```

---

## Task 4: Add `/api/stage-log` REST endpoint + WS notify

**Files:**
- Modify: `autoresearch/src/web.ts` (imports, `/api/stage-log`, fs.watch)

- [ ] **Step 1: Add imports + the endpoint handler**

In `autoresearch/src/web.ts`, find the imports block (line 1-47). Add to the bottom:

```ts
import { watch } from "fs";
import { stageLogPath } from "./stage_log";
import { getSkillState, getSkillDiff, getSkillShow } from "./skill_state";
```

Find the `if (url === "/api/state")` block (around line 277). Right before it, add the new `/api/stage-log` endpoint:

```ts
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
```

- [ ] **Step 2: Add fs.watch broadcasts after wss is created**

Find the line `const wss = new WebSocketServer({ server });` (around line 344). Right after the lifecycle-event wirings for `cli` and `loopTerm` (around line 359-366), add:

```ts
  // Watch .ar/stage-*.log for changes; notify clients to re-fetch via REST.
  for (let i = 0; i <= 6; i++) {
    const p = stageLogPath(cfg.workdir, i);
    try {
      // fs.watch fires even for files that don't yet exist on some platforms;
      // on Linux it errors with ENOENT. Tolerate by attempting later: re-arm
      // every 5 s for stages whose log file does not yet exist.
      const armWatcher = () => {
        if (!existsSync(p)) {
          setTimeout(armWatcher, 5000);
          return;
        }
        watch(p, { persistent: false }, () => {
          broadcast(wss, { type: "stage-log-updated", stage: i });
        });
      };
      armWatcher();
    } catch (e) { console.error(`[stage-log] watch ${i} failed:`, e); }
  }
```

- [ ] **Step 3: Build to confirm types**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npm run build
```

Expected: 0 errors.

- [ ] **Step 4: Smoke test the endpoint**

In one terminal:

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log
```

In another terminal:

```bash
# Simulate a stage log existing
mkdir -p /home/fxy/angle/.ar
echo "# iter 1  stage 3  begin" > /home/fxy/angle/.ar/stage-3.log
echo "build output here" >> /home/fxy/angle/.ar/stage-3.log

# Fetch via REST
curl -s --noproxy '*' 'http://127.0.0.1:8080/api/stage-log?stage=3'
```

Expected:

```
# iter 1  stage 3  begin
build output here
```

Test 404 path:

```bash
curl -s --noproxy '*' -w '\n[code %{http_code}]\n' 'http://127.0.0.1:8080/api/stage-log?stage=9'
```

Expected: 404 with `stage-9.log not yet written`.

Stop the server (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add autoresearch/src/web.ts
git commit -m "feat(web): add /api/stage-log endpoint + fs.watch WS notify"
```

---

## Task 5: Add `/api/skill-state`, `/api/skill-diff`, `/api/skill-show` endpoints

**Files:**
- Modify: `autoresearch/src/web.ts`

- [ ] **Step 1: Add the three endpoint handlers**

In `autoresearch/src/web.ts`, inside `http.createServer((req, res) => { … })`, right after the `/api/stage-log` handler you added in Task 4, append:

```ts
    // Skill manifest + diff-vs-champion summary (top-center quadrants).
    if (url === "/api/skill-state") {
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
```

- [ ] **Step 2: Add `skillState` to the 2 s status interval**

Find the `setInterval(() => { broadcast(wss, … ) }, 2000)` block at the bottom of `startWebServer` (around line 486-499). After the existing `broadcast(wss, getHistory(cfg));` line, append:

```ts
    broadcast(wss, { type: "skill-state", ...getSkillState(cfg.skillDir) });
```

Then update the JSDoc protocol comment at the top of `web.ts` (around line 16-36) — add to the `server → client:` section:

```
 *     { type:"skill-state",          ...SkillState }   每 2s 推
 *     { type:"stage-log-updated",    stage:number }    fs.watch 触发
```

- [ ] **Step 3: Also send `skillState` and `history` in the WS handshake**

Find the `wss.on("connection", (ws, req) => {` block (around line 398). After the existing `ws.send(JSON.stringify(getLogFiles(cfg)));` line (around line 424), append:

```ts
    ws.send(JSON.stringify(getHistory(cfg)));
    ws.send(JSON.stringify({ type: "skill-state", ...getSkillState(cfg.skillDir) }));
```

(The first line eliminates the 2-second window the spec describes; the second seeds the quadrants immediately.)

- [ ] **Step 4: Build**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npm run build
```

Expected: 0 errors.

- [ ] **Step 5: Smoke test**

Start the server:

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log
```

In another shell:

```bash
curl -s --noproxy '*' 'http://127.0.0.1:8080/api/skill-state' | python3 -m json.tool
```

Expected: JSON with `manifest.frozen` (4 entries), `manifest.evolving` (5 entries), `current.head`, `champion.head`. `diff` may be empty if you're on the champion commit.

```bash
curl -s --noproxy '*' 'http://127.0.0.1:8080/api/skill-diff?path=prompt.tmpl'
```

Expected: empty body or `(no diff …)` if no diff currently.

```bash
curl -s --noproxy '*' 'http://127.0.0.1:8080/api/skill-show?ref=champion&path=MANIFEST.yml'
```

Expected: MANIFEST.yml contents (or `(no content …)` if champion tag missing).

Stop the server.

- [ ] **Step 6: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add autoresearch/src/web.ts
git commit -m "feat(web): add /api/skill-{state,diff,show} + send on handshake"
```

---

## Task 6: Remove cli/main PTY broadcasts and stderr mirror from `web.ts`

**Files:**
- Modify: `autoresearch/src/web.ts`

Goal: stop the server pushing things into the dashboard's about-to-be-deleted xterm panes. Nothing else changes; InteractivePty stays running for credentials state.

- [ ] **Step 1: Delete the cli broadcast block**

In `autoresearch/src/web.ts`, find and **delete** this block (around lines 347-359):

```ts
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
```

- [ ] **Step 2: Delete the loopTerm.on('dead') broadcast**

Right after where the cli broadcasts used to be, find and **delete** (around lines 362-366):

```ts
  // Lifecycle for the loop's automation PTY → flag "main" pane as dead if
  // it ever exits. Bytes themselves arrive via the stderr mirror below
  // (loopTerm already writes its bytes to process.stderr).
  loopTerm.on("dead", () => {
    broadcast(wss, { type: "dead", term: "main", code: null, signal: null });
  });
```

- [ ] **Step 3: Delete the `process.stderr.write` hijack**

Find and **delete** the whole hijack block (around lines 368-396):

```ts
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
```

- [ ] **Step 4: Delete the PTY replay block in `wss.on("connection")`**

Find the connection handler. Delete the two replay lines (around line 410-411):

```ts
    if (ptyBuf.main) ws.send(JSON.stringify({ type: "pty", term: "main", data: ptyBuf.main }));
    if (ptyBuf.cli)  ws.send(JSON.stringify({ type: "pty", term: "cli",  data: ptyBuf.cli  }));
```

- [ ] **Step 5: Delete the ws message handlers for cli input/resize/restart**

In the same connection block, delete the cli-message handlers (around lines 432-449):

```ts
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
```

- [ ] **Step 6: Delete `ptyBuf` and `pty` from `/api/state` response**

Find and **delete** the `ptyBuf` declaration (around lines 136-140):

```ts
const PTY_BUF_BYTES = 64 * 1024;
const ptyBuf: Record<"main" | "cli", string> = { main: "", cli: "" };
function ptyAppend(name: "main" | "cli", d: string): void {
  ptyBuf[name] = (ptyBuf[name] + d).slice(-PTY_BUF_BYTES);
}
```

In `/api/state` payload (around line 291), delete:

```ts
        pty:     { main: ptyBuf.main, cli: ptyBuf.cli },
```

- [ ] **Step 7: Update the JSDoc protocol comment**

At the top of `web.ts`, in the protocol comment block (lines 15-36), remove every line that mentions `pty`, `cli` input/resize/restart, the `term:"main"` lines. Replace the whole section with:

```
 * 协议（JSON 帧）：
 *   server → client:
 *     { type:"status",  iter, total, phase, best, alive, stages } 每 2s 推
 *     { type:"git",     branch, lastCommit, changed:string[] }    每 2s 推
 *     { type:"log",     files: LogFile[] }                        每 2s 推
 *     { type:"history", commits, head }                           每 2s 推 + 握手
 *     { type:"skill-state",       ...SkillState }                 每 2s 推 + 握手
 *     { type:"stage-log-updated", stage:number }                  fs.watch 触发
 *     { type:"toast",   msg:string }                              一次性
 *
 *   client → server:
 *     { type:"config", dryRun:boolean }
 *     { type:"loop",   action:"start"|"stop", iterations? }
 *     { type:"apply",  hash:string }
```

- [ ] **Step 8: Build**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npm run build
```

Expected: 0 errors.

If you get unused-import errors for `InteractivePty` or `Terminal` parameters in `startWebServer`, leave the parameters in the signature (they are still passed from `index.ts`) — TypeScript with `noUnusedParameters: false` (the default for this tsconfig) won't complain.

- [ ] **Step 9: Smoke test**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
sleep 2
curl -s --noproxy '*' 'http://127.0.0.1:8080/api/state' | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "pty" not in d, d; print("OK: pty removed from /api/state")'
kill %1 2>/dev/null
```

Expected: `OK: pty removed from /api/state`.

- [ ] **Step 10: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add autoresearch/src/web.ts
git commit -m "refactor(web): drop cli pane broadcasts and stderr mirror"
```

---

## Task 7: Dashboard — strip the cli pane HTML/CSS/JS

**Files:**
- Modify: `Autoresearch Dashboard.html`

This task is pure UI deletion. After this task the page still works (no broken JS), it just has an empty bottom half until Task 8 fills it.

- [ ] **Step 1: Delete the cli xterm container element**

In `Autoresearch Dashboard.html`, find and **delete** this block (around lines 318-326):

```html
  <div id="divider"></div>
  <div class="term-wrap" id="term-cli-wrap">
    <div class="term-label">
      <div class="tl-dot active" id="cli-dot"></div>
      <span style="flex:1">CLI — 手动登录 / 调试 (claude login, copilot, …)</span>
      <button class="restart-btn" onclick="requestRestart('cli')" title="Restart cli bash">↻</button>
    </div>
    <div class="term-inner" id="term-cli"></div>
  </div>
```

Leave the `<div id="center"> … <div class="term-wrap" id="term-main-wrap"> … </div> </div>` intact — we will replace `term-main-wrap`'s contents in Task 8.

- [ ] **Step 2: Delete the cli xterm JS init**

Find and **delete** the line (around line 394):

```js
const cli  = makeTerm('term-cli');                                  // interactive shell
cli.term.focus();
```

Then delete the `cli.term.onData(...)` and `cli.term.onResize(...)` handlers (around lines 398-412):

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

Then in the ResizeObserver line right below, change:

```js
new ResizeObserver(() => { fitTerm(main); fitTerm(cli); }).observe(document.getElementById('center'));
```

to:

```js
new ResizeObserver(() => { fitTerm(main); }).observe(document.getElementById('center'));
```

- [ ] **Step 3: Update the divider drag handler**

Find (around lines 419-440):

```js
const divider   = document.getElementById('divider');
const cliWrap   = document.getElementById('term-cli-wrap');
const centerEl  = document.getElementById('center');
let dragging    = false;

divider.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const rect = centerEl.getBoundingClientRect();
  const pct  = Math.max(20, Math.min(70, (1 - (e.clientY - rect.top) / rect.height) * 100));
  cliWrap.style.flex = `0 0 ${pct}%`;
  …
});
```

This whole block depends on the deleted `divider` and `cliWrap`. **Delete it entirely.** A new divider for the quadrants ↔ stage-log split will be added in Task 8.

- [ ] **Step 4: Delete the WS message handlers tied to cli/main pane**

Find the `ws.onmessage` block (around line 735-755). Delete the `case` arms for `pty`, `dead`, `restarted`, `restart-failed`, `restart-check-result`:

```js
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
```

Replace with:

```js
      if (m.type === 'status') {
```

Keep the rest of the if/else chain (history, toast). Add new arms for the new message types — these will be wired in Task 8 to real handlers, but stub them now so the JSON parser doesn't log spurious errors:

```js
      } else if (m.type === 'skill-state') {
        // wired in Task 8
      } else if (m.type === 'stage-log-updated') {
        // wired in Task 8
      } else if (m.type === 'toast') {
```

(The `toast` arm already exists — you're just inserting the two new arms before it.)

- [ ] **Step 5: Delete the helper functions that no longer have callers**

`showDeadBanner`, `hideDeadBanner`, `requestRestart`, `handleRestartCheck` are now unreferenced. Find and delete them (around lines 674-706).

- [ ] **Step 6: Manual smoke test**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
sleep 2
```

Open `http://localhost:8080/` in a browser. Open DevTools Console. Expected:

- No JavaScript errors
- Top half: the existing `main` xterm still renders (will be replaced in Task 8 — leaving it visible is fine for now)
- Bottom half: blank (where cli was)
- Right panel: real version history loads instantly (no 2 s mock)

Stop the server.

- [ ] **Step 7: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add "Autoresearch Dashboard.html"
git commit -m "refactor(dashboard): strip cli pane HTML/CSS/JS"
```

---

## Task 8: Dashboard — add Stage Log panel (bottom center)

**Files:**
- Modify: `Autoresearch Dashboard.html`

- [ ] **Step 1: Replace `term-main-wrap` with the new stage log panel HTML**

In `Autoresearch Dashboard.html`, find the `<div id="center"> …` block (around lines 310-317). Replace its contents with:

```html
<div id="center">
  <section id="stage-log-panel">
    <header class="slp-head">
      <span class="slp-title">Loop — Stage Logs</span>
      <select id="slp-stage-sel" class="slp-sel">
        <option value="follow">📍 follow current</option>
        <option value="0">Stage 0 — Init</option>
        <option value="1">Stage 1 — Ideate</option>
        <option value="2">Stage 2 — Apply</option>
        <option value="3">Stage 3 — Build</option>
        <option value="4">Stage 4 — Verify</option>
        <option value="5">Stage 5 — Decide</option>
        <option value="6">Stage 6 — Schedule</option>
      </select>
      <span class="slp-meta" id="slp-meta">phase: —</span>
    </header>
    <pre id="slp-body" class="slp-body"></pre>
  </section>
</div>
```

(The skill quadrants section will be inserted *above* this in Task 9; for now the stage log panel takes the whole center column.)

- [ ] **Step 2: Add the CSS**

In the `<style>` block at the top of `Autoresearch Dashboard.html`, find the existing `.term-wrap`, `.term-label`, etc. rules (around lines 110-160) and **delete them** (they are no longer used). In their place, add:

```css
/* ── Center column: stage log panel ──────────────────────────── */
#center { display:flex; flex-direction:column; min-width:0; }
#stage-log-panel { display:flex; flex-direction:column; flex:1; min-height:0; background:var(--panel); }
.slp-head {
  display:flex; align-items:center; gap:8px; padding:6px 10px;
  border-bottom:1px solid var(--border); font-size:11px;
  color:var(--dim); text-transform:uppercase; letter-spacing:0.5px;
}
.slp-title { font-weight:600; color:var(--fg, #c9d1d9); text-transform:none; letter-spacing:0; }
.slp-sel {
  background:var(--bg); color:var(--fg, #c9d1d9);
  border:1px solid var(--border); border-radius:3px;
  padding:2px 6px; font-size:11px; font-family:inherit;
}
.slp-meta { margin-left:auto; font-size:10px; color:var(--dim); text-transform:none; letter-spacing:0; }
.slp-body {
  flex:1; min-height:0; margin:0; padding:8px 12px;
  font-family:'JetBrains Mono','Fira Code',monospace; font-size:12px; line-height:1.45;
  color:#c9d1d9; background:#0a0e14; overflow:auto;
  white-space:pre; tab-size:4;
}
```

- [ ] **Step 3: Delete the xterm `main` initialization (no longer used)**

Find (around line 393):

```js
const main = makeTerm('term-main', { wideCols: MAIN_WIDE_COLS });   // read-only mirror of loopTerm
```

**Delete this line.** Also delete the `MAIN_WIDE_COLS` constant (around line 374) and the `makeTerm` / `fitTerm` helper functions if no callers remain.

Search the file for `main.term` and `fitTerm`. Any remaining references must be deleted too. Common spots:
- `new ResizeObserver(() => { fitTerm(main); }).observe(...)` (added in Task 7 Step 2) — **delete the whole ResizeObserver line** since neither `main` nor `cli` exist anymore.
- `main.term.write(...)` inside `startDemo()` — leave for now; will be addressed in Task 11.

If `makeTerm` and `fitTerm` become unused, delete their definitions too (around line 376-391).

- [ ] **Step 4: Add the stage log JS**

Insert a new script block at the end of the `<script>` section, right before the final `connectWS();` call:

```js
// ─── Stage Log panel ──────────────────────────────────────────────────────────
const slpBody  = document.getElementById('slp-body');
const slpSel   = document.getElementById('slp-stage-sel');
const slpMeta  = document.getElementById('slp-meta');

let slpFollow  = true;                       // "follow current" mode
let slpCurrent = 0;                          // which stage we're currently viewing
let slpPhaseStage = 0;                       // last known phase → stage map

slpSel.addEventListener('change', () => {
  if (slpSel.value === 'follow') {
    slpFollow = true;
    slpCurrent = slpPhaseStage;
  } else {
    slpFollow = false;
    slpCurrent = Number(slpSel.value);
  }
  refetchStageLog();
});

// Server pushes "stage-log-updated" when fs.watch fires; we re-fetch via REST.
function onStageLogUpdated(stage) {
  if (stage === slpCurrent) refetchStageLog();
}

// Called whenever status arrives — extracts current stage from `phase` string,
// auto-switches the panel if in follow mode.
function updateStageLogFromStatus(m) {
  // phase format from loop.ts:  "iter N: stage M (label)"
  const mat = (m.phase || '').match(/stage (\d+)/);
  const stage = mat ? Number(mat[1]) : 0;
  slpPhaseStage = stage;
  slpMeta.textContent = `iter ${m.iter || '—'} · ${m.phase || '—'}`;
  if (slpFollow && stage !== slpCurrent) {
    slpCurrent = stage;
    refetchStageLog();
  }
}

async function refetchStageLog() {
  try {
    const r = await fetch(`/api/stage-log?stage=${slpCurrent}`, { cache: 'no-store' });
    if (r.status === 404) {
      slpBody.textContent = `(stage-${slpCurrent}.log not yet written)`;
      return;
    }
    const text = await r.text();
    const wasAtBottom = slpBody.scrollTop + slpBody.clientHeight >= slpBody.scrollHeight - 8;
    slpBody.textContent = text;
    if (wasAtBottom) slpBody.scrollTop = slpBody.scrollHeight;
  } catch (e) {
    // network died; leave existing content alone
  }
}
```

- [ ] **Step 5: Wire `updateStageLogFromStatus` into `updateStatus`**

Find `function updateStatus(m) {` (around line 759). At the END of the function (right before the closing `}`), add:

```js
  updateStageLogFromStatus(m);
```

- [ ] **Step 6: Wire the new WS message arm**

Find the placeholder arm you added in Task 7:

```js
      } else if (m.type === 'stage-log-updated') {
        // wired in Task 8
```

Replace with:

```js
      } else if (m.type === 'stage-log-updated') {
        onStageLogUpdated(m.stage);
```

- [ ] **Step 7: Initial fetch on page load**

At the very bottom of the `<script>` (just before `connectWS()`), add:

```js
refetchStageLog();
```

So the panel shows the current stage 0 log immediately on load.

- [ ] **Step 8: Manual smoke test**

Start server, open browser, watch the stage log panel:

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
mkdir -p /home/fxy/angle/.ar
cat > /home/fxy/angle/.ar/stage-0.log <<'EOF'
# iter 0  stage 0  begin  2026-05-14T12:30:00Z
# cmd: setupCmds (3)
$ export CCACHE_DIR=$HOME/.ccache
$ cd /home/fxy/angle && git config user.email autoresearch@local
$ [ -d /mnt/f/code2/target_skill/.git ] || git init …
# exit=0  duration=145ms  end  2026-05-14T12:30:00Z
EOF
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
sleep 2
```

Open `http://localhost:8080/`. Expected:

- Bottom panel shows the stage-0.log contents you wrote
- "phase: —" or similar in the right of the header
- Selecting "Stage 3 — Build" from dropdown → panel switches to "(stage-3.log not yet written)" or stage-3 content
- Append a line to stage-0.log on disk → after re-fetch (fs.watch should notify within ~100 ms) panel auto-updates

Stop the server.

- [ ] **Step 9: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): add Stage Log panel with auto-follow"
```

---

## Task 9: Dashboard — add Skill Quadrants panel (top center)

**Files:**
- Modify: `Autoresearch Dashboard.html`

- [ ] **Step 1: Insert the quadrants HTML above the stage log panel**

In `Autoresearch Dashboard.html`, find `<div id="center">` and insert the quadrants `<section>` + a divider as the FIRST children, before `<section id="stage-log-panel">`:

```html
<div id="center">
  <section id="skill-quadrants">
    <div class="quad" id="q-evolving-unchanged">
      <div class="quad-title"><span>evolving · unchanged</span><span class="quad-count" id="qc-eu">0</span></div>
      <ul class="quad-list" id="ql-eu"></ul>
    </div>
    <div class="quad" id="q-evolving-changed">
      <div class="quad-title"><span>evolving · CHANGED</span><span class="quad-count" id="qc-ec">0</span></div>
      <ul class="quad-list" id="ql-ec"></ul>
    </div>
    <div class="quad" id="q-frozen">
      <div class="quad-title"><span>frozen</span><span class="quad-count" id="qc-fz">0</span></div>
      <ul class="quad-list" id="ql-fz"></ul>
    </div>
    <div class="quad" id="q-winner">
      <div class="quad-title"><span>evolving · WINNER</span><span class="quad-count" id="qc-wn">0</span></div>
      <ul class="quad-list" id="ql-wn"></ul>
    </div>
  </section>
  <div id="center-divider"></div>
  <section id="stage-log-panel">
    <!-- (existing stage log panel from Task 8) -->
  </section>
</div>
```

(Keep the existing `<section id="stage-log-panel">` content from Task 8 in place; we're only adding siblings above it.)

- [ ] **Step 2: Add the CSS**

In the `<style>` block, append:

```css
/* ── Center column: skill quadrants ──────────────────────────── */
#skill-quadrants {
  flex: 0 0 50%; min-height:0;
  display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr;
  gap:1px; background:var(--border);
}
#q-evolving-unchanged { grid-area: 1 / 1; }
#q-evolving-changed   { grid-area: 1 / 2; }
#q-frozen             { grid-area: 2 / 1; }
#q-winner             { grid-area: 2 / 2; }
.quad { background:var(--panel); display:flex; flex-direction:column; min-height:0; }
.quad-title {
  display:flex; align-items:center; justify-content:space-between;
  padding:6px 10px; border-bottom:1px solid var(--border);
  font-size:10px; text-transform:uppercase; letter-spacing:1px; color:var(--dim);
  position:sticky; top:0; background:var(--panel); z-index:1;
}
.quad-count { font-weight:600; color:#c9d1d9; }
#q-evolving-changed .quad-title { color: var(--orange, #e3b341); }
#q-winner            .quad-title { color: var(--green,  #3fb950); }
.quad-list {
  flex:1; min-height:0; overflow-y:auto;
  margin:0; padding:0; list-style:none;
}
.quad-list li {
  display:flex; align-items:center; gap:6px;
  padding:4px 10px; font-size:11px;
  font-family:'JetBrains Mono','Fira Code',monospace;
  border-bottom:1px solid rgba(255,255,255,0.03);
  color:#c9d1d9;
}
.quad-list li.clickable { cursor:pointer; }
.quad-list li.clickable:hover { background:rgba(88,166,255,0.08); }
.quad-list .qf-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.quad-list .qf-add { color:#3fb950; font-size:10px; }
.quad-list .qf-del { color:#f85149; font-size:10px; }

/* divider between quadrants and stage log */
#center-divider {
  flex:0 0 4px; cursor:row-resize; background:var(--border);
}
#center-divider:hover { background:var(--blue, #58a6ff); }
```

- [ ] **Step 3: Add the JS render + click handlers**

In the `<script>` block, after the Stage Log JS from Task 8, append:

```js
// ─── Skill Quadrants ──────────────────────────────────────────────────────────
function renderSkillState(s) {
  const frozen     = s.manifest?.frozen   ?? [];
  const evolving   = s.manifest?.evolving ?? [];
  const diff       = s.diff ?? [];
  const diffSet    = new Map(diff.map(d => [d.path, d]));
  const changed    = evolving.filter(p =>  diffSet.has(p));
  const unchanged  = evolving.filter(p => !diffSet.has(p));

  // Helpers
  const fileLi = (path, opts = {}) => {
    const d = opts.diffEntry;
    const stats = d ? `<span class="qf-add">+${d.added}</span><span class="qf-del">-${d.removed}</span>` : '';
    const cls = opts.clickable ? 'clickable' : '';
    return `<li class="${cls}" data-path="${esc(path)}" data-action="${esc(opts.action || '')}">
      <span class="qf-path" title="${esc(path)}">${esc(path)}</span>${stats}
    </li>`;
  };

  document.getElementById('ql-fz').innerHTML = frozen.map(p => fileLi(p)).join('');
  document.getElementById('ql-eu').innerHTML = unchanged.map(p => fileLi(p, { clickable:true, action:'show-champion' })).join('');
  document.getElementById('ql-ec').innerHTML = changed.map(p => fileLi(p, { clickable:true, action:'show-diff', diffEntry: diffSet.get(p) })).join('');
  document.getElementById('ql-wn').innerHTML = evolving.map(p => fileLi(p, { clickable:true, action:'show-champion' })).join('');

  document.getElementById('qc-fz').textContent = frozen.length;
  document.getElementById('qc-eu').textContent = unchanged.length;
  document.getElementById('qc-ec').textContent = changed.length;
  document.getElementById('qc-wn').textContent = evolving.length;
}

// Delegated click handler for quadrant file rows
document.getElementById('skill-quadrants').addEventListener('click', async (e) => {
  const li = e.target.closest('li.clickable');
  if (!li) return;
  const path   = li.dataset.path;
  const action = li.dataset.action;
  let title, body;
  if (action === 'show-diff') {
    title = `diff: ${path}  (champion..HEAD)`;
    const r = await fetch(`/api/skill-diff?path=${encodeURIComponent(path)}`);
    body = await r.text();
  } else if (action === 'show-champion') {
    title = `${path}  @ champion`;
    const r = await fetch(`/api/skill-show?ref=champion&path=${encodeURIComponent(path)}`);
    body = await r.text();
  } else { return; }
  openModal(title, body);
});

function openModal(title, body) {
  let modal = document.getElementById('quad-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'quad-modal';
    modal.innerHTML = `
      <div class="qm-backdrop" onclick="closeModal()"></div>
      <div class="qm-box">
        <header class="qm-head">
          <span class="qm-title" id="qm-title"></span>
          <button class="qm-close" onclick="closeModal()">✕</button>
        </header>
        <pre class="qm-body" id="qm-body"></pre>
      </div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('qm-title').textContent = title;
  document.getElementById('qm-body').textContent  = body || '(empty)';
  modal.style.display = 'block';
}
function closeModal() {
  const m = document.getElementById('quad-modal');
  if (m) m.style.display = 'none';
}
```

- [ ] **Step 4: Add modal CSS**

Append to the `<style>` block:

```css
/* ── Quadrant modal ─────────────────────────────────────────── */
#quad-modal { position:fixed; inset:0; z-index:100; display:none; }
#quad-modal .qm-backdrop { position:absolute; inset:0; background:rgba(0,0,0,0.6); }
#quad-modal .qm-box {
  position:absolute; left:10%; top:8%; right:10%; bottom:8%;
  background:var(--panel); border:1px solid var(--border); border-radius:4px;
  display:flex; flex-direction:column; min-height:0;
}
#quad-modal .qm-head {
  display:flex; align-items:center; padding:8px 12px;
  border-bottom:1px solid var(--border); font-size:12px;
}
#quad-modal .qm-title { flex:1; color:#c9d1d9; font-family:monospace; }
#quad-modal .qm-close {
  background:none; border:1px solid var(--border); color:var(--dim);
  cursor:pointer; padding:2px 8px; border-radius:3px;
}
#quad-modal .qm-body {
  flex:1; min-height:0; margin:0; padding:12px;
  font-family:'JetBrains Mono','Fira Code',monospace; font-size:11px; line-height:1.5;
  color:#c9d1d9; background:#0a0e14; overflow:auto; white-space:pre;
}
```

- [ ] **Step 5: Wire the WS message arm**

Find the placeholder arm in `ws.onmessage`:

```js
      } else if (m.type === 'skill-state') {
        // wired in Task 8
```

Replace with:

```js
      } else if (m.type === 'skill-state') {
        renderSkillState(m);
```

(The `m` object from the server has `manifest`, `current`, `champion`, `diff` directly — `renderSkillState` reads them.)

- [ ] **Step 6: Add divider drag handler**

In the `<script>`, append:

```js
// ─── Center divider drag (quadrants ↔ stage log) ──────────────────────────────
{
  const div   = document.getElementById('center-divider');
  const quad  = document.getElementById('skill-quadrants');
  const ctr   = document.getElementById('center');
  let drag = false;
  div.addEventListener('mousedown', (e) => { drag = true; e.preventDefault(); });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const r = ctr.getBoundingClientRect();
    const pct = Math.max(20, Math.min(80, (e.clientY - r.top) / r.height * 100));
    quad.style.flex = `0 0 ${pct}%`;
  });
  document.addEventListener('mouseup', () => { drag = false; });
}
```

- [ ] **Step 7: Initial fetch on page load**

Right next to `refetchStageLog()` (from Task 8) at the very bottom of `<script>`, add:

```js
fetch('/api/skill-state').then(r => r.json()).then(renderSkillState).catch(() => {});
```

- [ ] **Step 8: Manual smoke test**

Start the server, open browser:

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
sleep 2
```

Open `http://localhost:8080/`. Expected:

- 2×2 grid visible above the stage log panel
- top-left "evolving · unchanged" populated with `inputs/rules.MD`, `inputs/cold_path.MD`, `inputs/correlation.MD`, `prompt.tmpl`, `lib/fuse_context.py` (5 items, assuming no current diff vs champion)
- top-right "evolving · CHANGED" empty (assuming no diff)
- bottom-left "frozen" populated with 4 items (`SKILL.md`, `run.sh`, `lib/parse_output.py`, `MANIFEST.yml`)
- bottom-right "evolving · WINNER" populated with the same 5 evolving files
- Clicking a file in top-left, top-right (if any), or bottom-right opens a modal with content or diff

Test the changed case — modify a file in the skill repo:

```bash
echo "// test edit" >> /mnt/f/code2/target_skill/struct_layout_opt/prompt.tmpl
# wait 2s for the next status broadcast
```

Expected: `prompt.tmpl` moves from "evolving · unchanged" to "evolving · CHANGED" with `+1 -0` stats. Clicking opens a diff modal.

Revert the change:

```bash
git -C /mnt/f/code2/target_skill checkout struct_layout_opt/prompt.tmpl
```

Stop the server.

- [ ] **Step 9: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): add Skill Quadrants panel + diff/show modals"
```

---

## Task 10: Dashboard — initial version history on WS handshake

This was already done server-side in Task 5 Step 3. Verify the UI uses it.

**Files:**
- Modify: `Autoresearch Dashboard.html` (only if mock commits still render)

- [ ] **Step 1: Find the inline mock commits**

In `Autoresearch Dashboard.html`, find the inline `renderHistory({...4 mock commits...})` call (around line 642-650):

```js
renderHistory({
  branch:'main',
  commits:[
    { hash:'c9e3f21',iter:3,status:'keep',    metric:1234567890,delta:-415432110,files:['src/libANGLE/Context.h'],isCurrent:true  },
    { hash:'d8b2a10',iter:2,status:'discard', metric:1780000000,delta:130000000, files:['src/libANGLE/Program.h'],isCurrent:false },
    { hash:'b1c4e09',iter:1,status:'keep',    metric:1650000000,delta:-150000000,files:['src/libANGLE/State.h'],  isCurrent:false },
    { hash:'a3f9d1c',iter:0,status:'baseline',metric:1800000000,delta:null,      files:[],                        isCurrent:false },
  ],
});
```

- [ ] **Step 2: Replace it with an empty-state call**

Replace the block above with:

```js
// Initial render: empty state. Real history arrives via WS handshake (Task 5).
// The mock 4 commits are now ?demo=1 only — see Task 11.
renderHistory({ branch: '—', commits: [] });
```

(The mock commits will be restored conditionally in Task 11 under the `?demo=1` gate.)

- [ ] **Step 3: Manual smoke test**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
sleep 2
```

Open `http://localhost:8080/`. Expected:

- Right panel "版本历史" shows real commits **immediately** (within ~200ms of page load — the WS handshake arrives before the first 2 s status interval).
- No flash of the 4 fake `c9e3f21`/`d8b2a10`/`b1c4e09`/`a3f9d1c` commits.

If the angle repo has no `experiment: iter N` commits yet, expect "No experiment commits yet".

Stop the server.

- [ ] **Step 4: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add "Autoresearch Dashboard.html"
git commit -m "fix(dashboard): drop inline mock commits; rely on WS handshake history"
```

---

## Task 11: Dashboard — demo isolation behind `?demo=1`

**Files:**
- Modify: `Autoresearch Dashboard.html`

- [ ] **Step 1: Add the DEMO pill markup to the header**

In `Autoresearch Dashboard.html`, find the header block where `ws-dot` lives (around lines 270-273):

```html
  <div style="display:flex;align-items:center;gap:5px;">
    <div class="ws-dot demo" id="ws-dot"></div>
    <span style="font-size:11px;color:var(--dim)" id="ws-label">demo</span>
  </div>
```

Replace with:

```html
  <div style="display:flex;align-items:center;gap:8px;">
    <span id="demo-pill" style="display:none;background:var(--orange,#e3b341);color:#0d1117;font-size:10px;font-weight:600;padding:2px 8px;border-radius:3px;letter-spacing:0.5px;">DEMO</span>
    <div class="ws-dot" id="ws-dot"></div>
    <span style="font-size:11px;color:var(--dim)" id="ws-label">连接中…</span>
  </div>
```

(`ws-dot` no longer starts in the `.demo` class — the real connection attempt should drive its state.)

- [ ] **Step 2: Add the `.dead` red-dot CSS class**

In the `<style>` block, find the existing `ws-dot` rules (around lines 65-68):

```css
.ws-dot.connected { background:var(--green); }
.ws-dot.demo { background:var(--yellow); }
```

Append:

```css
.ws-dot           { background:var(--dim, #6e7681); }   /* default = "connecting…" gray */
.ws-dot.dead      { background:var(--red, #f85149); }
```

- [ ] **Step 3: Update `ws.onclose` to use `.dead` and drop the auto-demo branch**

Find `ws.onclose = () => { … }` (around lines 720-733). Replace it with:

```js
    ws.onclose = () => {
      ws = null;
      document.getElementById('ws-dot').className = 'ws-dot dead';
      document.getElementById('ws-label').textContent = '服务器已断开 — 重连中…';
      const delay = WS_DELAYS[Math.min(wsReconnectAttempt, WS_DELAYS.length - 1)];
      wsReconnectAttempt++;
      startPolling();
      setTimeout(connectWS, delay);
    };
```

(The deleted line is the `if (wsReconnectAttempt === 3 && !demoRunning) startDemo();` branch.)

- [ ] **Step 4: Replace the bottom `connectWS()` call with a demo gate**

Find the very bottom of `<script>` where it currently has (around line 887):

```js
connectWS();
```

(And the new `refetchStageLog()` + `fetch('/api/skill-state')...` calls from Task 8/9 right above it.)

Replace the whole bottom-of-script with:

```js
const DEMO_MODE = new URLSearchParams(location.search).has('demo');

if (DEMO_MODE) {
  document.getElementById('demo-pill').style.display = '';
  document.getElementById('ws-dot').className = 'ws-dot demo';
  document.getElementById('ws-label').textContent = 'demo';
  // Restore the 4 fake commits ONLY in demo mode.
  renderHistory({
    branch:'main',
    commits:[
      { hash:'c9e3f21',iter:3,status:'keep',    metric:1234567890,delta:-415432110,files:['src/libANGLE/Context.h'],isCurrent:true  },
      { hash:'d8b2a10',iter:2,status:'discard', metric:1780000000,delta:130000000, files:['src/libANGLE/Program.h'],isCurrent:false },
      { hash:'b1c4e09',iter:1,status:'keep',    metric:1650000000,delta:-150000000,files:['src/libANGLE/State.h'],  isCurrent:false },
      { hash:'a3f9d1c',iter:0,status:'baseline',metric:1800000000,delta:null,      files:[],                        isCurrent:false },
    ],
  });
  startDemo();
} else {
  refetchStageLog();
  fetch('/api/skill-state').then(r => r.json()).then(renderSkillState).catch(() => {});
  connectWS();
}
```

- [ ] **Step 5: Keep `startDemo` working with the new layout**

`startDemo()` writes to `main.term.write(...)` — but `main` was deleted in Task 8 Step 3. Make it write to the stage log panel `<pre>` instead, so demo mode visually drives the new bottom panel.

Find `startDemo()` (around line 802). Find `main.term.write(...)` calls inside it. Replace each one with:

```js
slpBody.textContent += <existing first arg>;
slpBody.scrollTop = slpBody.scrollHeight;
```

(The existing template strings include ANSI like `${D}── Stage 0: …${W}`. Strip these too — use the new `stripAnsiPlain` helper below.)

Add this helper at the top of `startDemo()` (before the `seq` array):

```js
  const stripAnsiPlain = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const writeMain = s => { slpBody.textContent += stripAnsiPlain(s); slpBody.scrollTop = slpBody.scrollHeight; };
```

Then in the `seq` array (the `[delay, fn]` pairs), replace every `main.term.write(...)` with `writeMain(...)`. Replace every `cli.term.write(...)` with — well, there's no cli anymore. For the cli writes in demo (around lines 815-819), redirect them to the stage log panel as well:

```js
    [200,  () => { writeMain(`$ gh copilot suggest -t shell\n`); }],
    [800,  () => { writeMain(`Analyzing ANGLE rendering pipeline...\n`); }],
    [700,  () => { writeMain(`Generating struct layout optimization...\n`); }],
    [600,  () => { writeMain(`diff --git a/src/libANGLE/Context.h b/src/libANGLE/Context.h\n+  alignas(64) ContextState mState;\n+  __builtin_prefetch(&mState, 0, 3);\n`); }],
```

Also remove the `document.getElementById('cli-dot').classList.add('active')` (and `.remove`) calls — cli-dot no longer exists.

- [ ] **Step 6: Manual smoke test — normal mode**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
sleep 2
```

Open `http://localhost:8080/`. Expected:

- ws-dot transitions: gray → green (no yellow demo dot ever appears)
- No "DEMO" pill in header
- No fake stage progress
- All 7 stages start gray; only Stage 0 may flip to `confirm` from the server

Kill the server (Ctrl+C). Expected in browser:

- ws-dot turns red
- Label: "服务器已断开 — 重连中…"
- **Stages stay where they were** — no demo simulation
- Stage log panel keeps showing whatever was last fetched (no fake "── Stage 0: …" lines)

- [ ] **Step 7: Manual smoke test — demo mode**

With server stopped, open `http://localhost:8080/?demo=1`. Expected:

- DEMO pill visible in top-right of header (orange)
- ws-dot yellow, label "demo"
- 4 mock commits in right panel
- Stage log panel walks through Stage 0 → Stage 6 over ~10 seconds, stages flipping green via `setStageStatus`
- No WebSocket connection attempts in DevTools Network tab

- [ ] **Step 8: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add "Autoresearch Dashboard.html"
git commit -m "feat(dashboard): gate demo behind ?demo=1; red banner on disconnect"
```

---

## Task 12: Update `how-to.md`

**Files:**
- Modify: `how-to.md`

- [ ] **Step 1: Add the new `.ar/` directory + endpoints**

In `how-to.md`, find the section "REST 拉取 — `GET /api/state`" (around line 141). Right before that subsection, add:

```markdown
### 新增 REST 端点(meta-loop dashboard)

| 路径 | 用途 |
|---|---|
| `GET /api/state` | 状态快照(原有) |
| `GET /api/stage-log?stage=N` | `${workdir}/.ar/stage-N.log` 全文,默认从 head 截断到 1 MB |
| `GET /api/skill-state` | skillDir 的 MANIFEST.yml 分类 + diff vs champion |
| `GET /api/skill-diff?path=…` | `git diff champion..HEAD -- <path>`(仅 evolving 文件) |
| `GET /api/skill-show?ref=champion&path=…` | `git show champion:<path>`(查看获胜版本) |

WebSocket 新事件:
- `{type:"stage-log-updated", stage:N}` — fs.watch 触发,客户端去 REST 拉
- `{type:"skill-state", manifest, current, champion, diff}` — 每 2s 推 + 握手

### .ar/ 目录

loop.ts 每次进入一个 stage 都会把 stdout/stderr 写到
`${workdir}/.ar/stage-N.log`。每个 stage 文件**进入时截断**,
不跨 iter 累加(跨 iter 历史用 `loop.log` 或 `results.tsv`)。

如果 workdir 是 git 仓库,把 `.ar/` 加到本地 exclude 不污染 status:

\`\`\`bash
echo .ar/ >> /home/fxy/angle/.git/info/exclude
\`\`\`
```

- [ ] **Step 2: Update Stage 0 paragraph to reflect cli-pane removal**

Find the paragraph (around line 66-70):

> Stage 0 是 `confirm` 状态。**通常情况下不需要手动 `claude login`** —
> `~/.claude/.credentials.json` 一旦存在(任何之前的 claude 会话都会留),
> autoresearch 的 PTY 直接继承 `HOME` 拿到。点 ✓ Confirm & Continue 就走
> setupCmds(包括 target_skill `git init` 兜底)然后 baseline。

Replace with:

> Stage 0 是 `confirm` 状态。**通常情况下不需要手动 `claude login`** —
> `~/.claude/.credentials.json` 一旦存在(任何之前的 claude 会话都会留),
> autoresearch 的 PTY 直接继承 `HOME` 拿到。点 ✓ Confirm & Continue 就走
> setupCmds(包括 target_skill `git init` 兜底)然后 baseline。
>
> **2026-05-14 起 dashboard 删除了 cli 交互面板** — Claude CLI 只需登录
> 一次,日常运行不再需要 dashboard 嵌入终端。如要重新登录,在启动
> autoresearch 服务器之前在普通终端跑 `claude login` 即可。

- [ ] **Step 3: Add `?demo=1` to the dashboard 入口 section**

Find the "代理坑" paragraph (around line 63-65). Right after it, add:

> **演示模式**:`http://localhost:8080/?demo=1` 走前端模拟(7 个 stage
> 假序列 + 4 条 mock commits),用于在没服务器的环境检查 UI 渲染。普通
> 访问(无 `?demo=1`)的 ws-dot 状态有 4 种:
>
> | 颜色 | 含义 |
> |---|---|
> | 灰 | 初始/连接中 |
> | 绿 + `已连接` | WebSocket 通 |
> | 绿 + `HTTP 轮询` | WS 断,fallback 到 /api/state 每 2s |
> | 红 + `服务器已断开 — 重连中…` | 服务进程死了 |

(Delete the original yellow "demo" line in the table that's already there — replaced by 4-row table.)

Find this older paragraph (around line 56-60):

> 右上角 ws-dot 颜色:
> - 绿色 + `已连接` = WebSocket 通,实时推
> - 绿色 + `HTTP 轮询` = WS 被代理拦,自动 fallback 到 `/api/state` 每 2s 拉
> - 黄色 + `demo` = WS 也死、polling 也死,演示数据,你看到的是假的

Delete it (replaced by the table above).

- [ ] **Step 4: Verify**

```bash
cd /mnt/f/code2/struct_cache_opt
grep -n "cli pane\|demo=1\|\.ar/\|stage-log\|skill-state" how-to.md | head -20
```

Expected: 5+ matches across the new content.

- [ ] **Step 5: Commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add how-to.md
git commit -m "docs(how-to): document .ar/ dir, demo URL, cli-pane removal"
```

---

## Task 13: End-to-end verification

**Files:** None modified — pure verification.

- [ ] **Step 1: Run full test suite**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npm test
```

Expected: all 6 suites pass (M1-M6).

- [ ] **Step 2: Run tsc type-check**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npm run build
```

Expected: 0 errors.

- [ ] **Step 3: Manual end-to-end smoke**

```bash
# 1. Fresh start
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
SERVER=$!
sleep 2
```

Open `http://localhost:8080/`. Walk through the checklist from the spec §6:

- [ ] (a) ws-dot is green, **no demo Stage 0–6 flicker**, version history populated immediately
- [ ] (b) Skill Quadrants 2×2 panel visible with correct frozen/evolving counts (4 + 5)
- [ ] (c) Loop—Stage Logs panel shows "(stage-0.log not yet written)" or similar empty state initially

Now Ctrl+C the server:

```bash
kill -INT $SERVER
```

- [ ] (d) ws-dot turns red, banner "服务器已断开 — 重连中…"
- [ ] (e) **No fake stage progress** appears in either the quadrants or the log panel
- [ ] (f) Setup Stages list keeps whatever real state it had — not all green

Restart the server, wait, refresh the page:

```bash
npx tsx src/index.ts ../vk-image-helper.yml 2> /tmp/loop-smoke.log &
sleep 2
```

- [ ] (g) ws-dot back to green, all panels re-populate

Test demo mode:

```bash
# stop server
kill %1 2>/dev/null
```

Open `http://localhost:8080/?demo=1`:

- [ ] (h) DEMO pill in header (orange)
- [ ] (i) 4 mock commits in version history
- [ ] (j) Full 7-stage simulation walks through with green progression
- [ ] (k) No WS connection attempts (Network tab clean of `ws://` requests)

- [ ] **Step 4: If anything in Step 3 fails — STOP**

Do not commit a "fixup" until the failure is traced back to the originating task. The plan's tasks are designed so each commit is independently verifiable; a regression here means a previous task's smoke step was insufficient.

- [ ] **Step 5: If everything passes — push the branch**

```bash
cd /mnt/f/code2/struct_cache_opt
git log --oneline -15
```

Expected: 12-13 new commits on top of `aced935` (the spec correction commit).

(No automatic `git push` — the user will decide branch/PR strategy after reviewing the diff locally.)

---

## Spec coverage check (writer self-review)

| Spec §  | Task |
|---|---|
| §3.1 Module A: ws.onclose → red banner instead of demo | 11 (Step 3) |
| §3.1 Module A: `?demo=1` URL gate | 11 (Step 4) |
| §3.1 Module A: DEMO pill in header | 11 (Step 1) |
| §3.1 Module A: remove inline mock commits from normal load | 10 |
| §3.2 Module B: delete `term-cli-wrap` + cli xterm + handlers | 7 |
| §3.2 Module B: new `#skill-quadrants` 2×2 grid | 9 |
| §3.2 Module B: new `#stage-log-panel` with `<pre>` + selector | 8 |
| §3.2 Module B: server stops cli/main broadcasts + stderr hijack | 6 |
| §3.3.1 stage-N.log file format + truncation | 1 (helpers) + 2 (integration) |
| §3.3.1 `/api/stage-log` endpoint | 4 |
| §3.3.1 WS `stage-log-updated` via fs.watch | 4 |
| §3.3.2 `/api/skill-state` + handshake send | 5 (Step 1, Step 3) |
| §3.3.2 click → `/api/skill-diff` modal | 9 (click delegation) |
| §3.3.2 click → `/api/skill-show?ref=champion` modal | 9 (click delegation) |
| §3.3.3 `history` sent on WS handshake | 5 (Step 3) |
| §6 verification checklist 1–7 | 13 (Step 3) |
| §7 Stage 0 confirm not changed (out of scope) | n/a (explicitly skipped) |
| §8 how-to.md updates | 12 |

No spec requirement is missing a task.

## Placeholder scan

No "TBD" / "TODO" / "fill in details" / "similar to Task N" / unspecified code remaining. Every step that touches code has the literal code shown.

## Type consistency

- `Manifest`, `DiffEntry`, `SkillState` types defined in Task 3 step 3; used consistently in Task 5 (endpoint payloads) and Task 9 (browser-side render).
- `stageLogPath`, `writeStageLogHead`, `writeStageLogTail` names match between Task 1 (definition), Task 2 (consumption in loop.ts), and Task 4 (consumption in web.ts).
- WS message types `skill-state`, `stage-log-updated` named consistently between Task 5 (server emit), Task 7 (browser placeholder), Task 8 + 9 (real handlers).
- `slpBody`, `slpSel`, `slpMeta` element IDs match between Task 8 (HTML markup `slp-body`/`slp-stage-sel`/`slp-meta`) and the corresponding `getElementById` calls in the JS.

Plan complete and saved to `docs/superpowers/plans/2026-05-14-dashboard-meta-rework.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints
