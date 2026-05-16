import { Terminal, CmdResult } from "./terminal";
import { ensure, append, tail, bestSoFar, Row } from "./logger";
import { Config } from "./config";
import { loopState, setStage, resetIterStages } from "./web";
import { writeStageLogHead, writeStageLogTail } from "./stage_log";
import { join } from "path";

// S/scripts/recount_diff.py (loop.ts is autoresearch/src → ../../scripts).
// LLM diffs ship bogus @@ counts AND hallucinated start lines; recount makes
// them parse-clean so `patch --fuzz` can relocate the hunk by context.
declare const __dirname: string;
const RECOUNT = join(__dirname, "..", "..", "scripts", "recount_diff.py");

// ─── Runtime + dashboard controller ───────────────────────────────────────────
//
// `runtime` holds mutable flags the dashboard / web layer flips at runtime:
//   - dryRun: replace the LLM call with `cat <dryRunPatch>` so the rest of the
//     pipeline still runs, and remap the resulting TSV row to status="dry-run".
//   - stopRequested: signal the iteration loop to break after the current iter.
//   - iterationsOverride: per-session iteration count from the dashboard's
//     "× <count>" input (overrides cfg.iterations for one session).
//   - signalStart(): resolve the awaitStart() promise so the loop proceeds.
//
// awaitStart() returns a promise that resolves when the dashboard sends
// {type:'loop', action:'start'}. If signalStart() fires before any awaiter is
// registered, the signal is buffered (one-deep) so we don't lose it.

let _startResolver: (() => void) | null = null;
let _pendingStart = false;

function awaitStart(): Promise<void> {
  if (_pendingStart) {
    _pendingStart = false;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => { _startResolver = resolve; });
}

export const runtime = {
  dryRun: false,
  stopRequested: false,
  iterationsOverride: undefined as number | undefined,
  signalStart(): void {
    if (_startResolver) {
      const r = _startResolver;
      _startResolver = null;
      r();
    } else {
      _pendingStart = true;
    }
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Extract the last whitespace-separated token from stdout, parse as number. */
function parseMetric(r: CmdResult): number | null {
  const token = r.stdout.trim().split(/\s+/).pop() ?? "";
  const n = Number(token.replace(/,/g, ""));
  return isFinite(n) && token !== "" ? n : null;
}

function makeRow(
  n:      number,
  status: Row["status"],
  metric: number | null,
  delta:  number | null,
  r:      CmdResult,
  desc:   string,
): Row {
  // Dry-run remap: keep the original outcome in `desc` so the operator can
  // tell what happened (build-fail / out-of-scope / would-keep / etc.), but
  // tag the row "dry-run" so bestSoFar() ignores it.
  const finalStatus =
    runtime.dryRun && status !== "baseline" ? "dry-run" : status;
  const finalDesc =
    runtime.dryRun && status !== "baseline" ? `${status}/${desc}` : desc;
  return {
    iter:   n,
    status: finalStatus,
    metric,
    delta,
    exit:   r.exitCode,
    warns:  r.warnings.length,
    desc:   finalDesc,
    ts:     new Date().toISOString(),
  };
}

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

async function runOrDie(
  t:          Terminal,
  cmd:        string,
  timeoutMs?: number,
): Promise<CmdResult> {
  const r = await t.run(cmd, timeoutMs);
  if (r.exitCode !== 0) {
    throw new Error(
      `runOrDie: exit ${r.exitCode}\ncmd: ${cmd}\nstderr: ${r.stderr}`,
    );
  }
  return r;
}

/** Run diagCmd if configured; return a short label suffix for TSV desc. */
async function runDiag(term: Terminal, diagCmd: string): Promise<string> {
  if (!diagCmd) return "";
  try {
    const d = await term.run(diagCmd, 60_000);
    const errLine = d.stderr.split("\n").find((l) => l.trim()) ?? "";
    const outLine = d.stdout.split("\n").find((l) => l.trim()) ?? "";
    const hint = (errLine || outLine).slice(0, 80).trim();
    if (hint) console.error(`[autoresearch] diag: ${hint}`);
    return hint ? ` | ${hint}` : "";
  } catch {
    return "";
  }
}

/**
 * Shell-quote a string for safe use as the value of `VAR=<value>`.
 * Single-quoted with embedded single quotes escaped via the standard
 * '\'' close-open pattern.
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Concatenate the stdout of contextCmds; failures emit a warning to stderr but don't abort. */
async function gatherContext(term: Terminal, cmds: string[]): Promise<string> {
  if (!cmds.length) return "";
  const parts: string[] = [];
  for (const cmd of cmds) {
    const r = await term.run(cmd, 5 * 60_000);
    if (r.exitCode !== 0) {
      console.error(`[autoresearch] contextCmd exit ${r.exitCode}: ${cmd}`);
    }
    if (r.stdout.trim()) parts.push(r.stdout.trim());
  }
  return parts.join("\n\n");
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
//
// runLoop is the outer lifecycle: it cd's into the workdir once, then forever
// awaits a dashboard Start signal and runs one session per signal. This lets
// the operator stop+restart from the dashboard without restarting the process,
// which is how the manual auth flow works:
//   1. tsx src/index.ts vk-image-helper.yml   # webserver up; loop awaiting
//   2. dashboard opens, operator types `claude login` etc. into the terminal
//   3. operator clicks Start → runtime.signalStart() → runSession runs
//   4. operator clicks Stop → runtime.stopRequested = true → session exits
//      cleanly, awaitStart() blocks again
//   5. operator can untick Dry Run, click Start again → next session

export async function runLoop(cfg: Config, term?: Terminal): Promise<void> {
  ensure(cfg.tsvPath, cfg.direction);

  // External term (from index.ts) → dashboard flow: forever await Start signals
  // and run one session per click. Internal term (no arg) → legacy/test flow:
  // create our own PTY, run one session, exit. Tests rely on the legacy flow
  // and call runLoop(cfg) directly.
  const standalone = !term;
  if (!term) {
    term = new Terminal();
    await term.start();
  }
  term.on("dead", (e: unknown) => console.error("[terminal dead]", e));

  if (cfg.remote) {
    await runOrDie(term, `${cfg.remote} 'cd ${cfg.workdir} && exec bash --noprofile --norc'`);
  } else {
    await runOrDie(term, `cd ${cfg.workdir}`);
  }

  if (standalone) {
    try {
      await runSession(cfg, term);
    } finally {
      term.dispose();
    }
    return;
  }

  for (;;) {
    console.error("[autoresearch] awaiting Start signal from dashboard…");
    await awaitStart();
    runtime.stopRequested = false;
    try {
      await runSession(cfg, term);
    } catch (e) {
      console.error("[autoresearch] session error:", e);
    }
    console.error("[autoresearch] session ended — awaiting next Start");
  }
}

async function exportEnv(term: Terminal, cfg: Config): Promise<void> {
  const exports: Record<string, string> = {
    AR_WORKDIR: cfg.workdir,
    AR_SCOPE:   cfg.scope.join(":"),
    AR_GOAL:    cfg.goal,
    ...(cfg.env ?? {}),
  };
  for (const [k, v] of Object.entries(exports)) {
    await runOrDie(term, `export ${k}=${shq(v)}`);
  }
}

// ─── Session — one Start click ────────────────────────────────────────────────

async function runSession(cfg: Config, term: Terminal): Promise<void> {
  await exportEnv(term, cfg);

  // setupCmds — gh auth (for non-interactive token flows), git config, etc.
  // Manual auth (e.g. `claude login`) is the operator's job in the dashboard
  // terminal BEFORE clicking Start; setupCmds run AFTER Start.
  setStage(0, "running");
  // Stage 0 is a sequence of setupCmds; emit one combined log so the dashboard
  // can show all setup output. The head truncates the file; each setupCmd
  // appends its result via writeStageLogTail.
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

  // Baseline (skipped if TSV already has one from a prior session).
  let best = bestSoFar(cfg.tsvPath, cfg.direction);
  if (best === null) {
    loopState.iter = 0;
    loopState.phase = "baseline (verify)";
    const v = await runOrDie(term, cfg.verifyCmd);
    const m = parseMetric(v);
    if (m === null) throw new Error("baseline: verifyCmd returned no numeric metric");
    best = m;
    append(cfg.tsvPath, makeRow(0, "baseline", best, null, v, "initial"));
    console.error(`[autoresearch] baseline = ${best}`);
  } else {
    console.error(`[autoresearch] resuming — best so far = ${best}`);
  }

  let sinceBest    = 0;
  let deadRetries  = 0;
  let metricErrors = 0;
  const iters = runtime.iterationsOverride ?? cfg.iterations ?? Infinity;

  for (let n = 1; n <= iters; n++) {
    if (runtime.stopRequested) {
      console.error("[autoresearch] stop requested — exiting session");
      loopState.phase = "stopped";
      return;
    }
    loopState.iter = n;
    loopState.phase = `iter ${n}: starting`;
    resetIterStages();
    console.error(`\n[autoresearch] ── iter ${n} ──`);

    if (!term.alive) {
      if (++deadRetries > 2) {
        console.error("[autoresearch] terminal dead 2× — exiting session");
        return;
      }
      console.error("[autoresearch] terminal dead — restarting");
      await term.start();
      if (cfg.remote) {
        await runOrDie(term, `${cfg.remote} 'cd ${cfg.workdir} && exec bash --noprofile --norc'`);
      } else {
        await runOrDie(term, `cd ${cfg.workdir}`);
      }
      await exportEnv(term, cfg);
      continue;
    }

    // 1. Review ─────────────────────────────────────────────────────────────
    const recentLog   = await term.run("git log -20 --oneline");
    const tsvTail     = tail(cfg.tsvPath, cfg.memoryDepth);
    const extraCtx    = await gatherContext(term, cfg.contextCmds ?? []);

    // 2+3. Pick + Modify — call ideatePrompt, get unified diff on stdout ────
    const ideateCmd = runtime.dryRun
      ? `cat ${cfg.dryRunPatch || "/dev/null"}`
      : cfg.ideatePrompt;
    const heredocTag = `AR_EOF_${rand()}`;
    const ctxBody =
      (extraCtx ? `${extraCtx}\n---\n` : ``) +
      `${recentLog.stdout}\n---\n${tsvTail}`;
    loopState.phase = `iter ${n}: stage 1 (ideate)`;
    setStage(1, "running");
    console.error(`[iter ${n}] stage 1: ideate (${ideateCmd})`);
    const ideate = await runWithStageLog(
      term, cfg.workdir, 1, n,
      `${ideateCmd} <<'${heredocTag}'\n${ctxBody}\n${heredocTag}`,
      20 * 60_000,
    );
    console.error(
      `[iter ${n}] stage 1: ideate exit=${ideate.exitCode} ` +
      `stdout=${ideate.stdout.length}B stderr=${ideate.stderr.length}B ` +
      `(${ideate.durationMs}ms)`,
    );

    if (ideate.exitCode !== 0 || !ideate.stdout.trim()) {
      setStage(1, "error");
      console.error(
        `[iter ${n}] stage 1 FAIL — first 5 lines stdout:\n` +
        ideate.stdout.split("\n").slice(0, 5).map((l) => `  | ${l}`).join("\n") +
        `\n[iter ${n}] stage 1 FAIL — first 5 lines stderr:\n` +
        ideate.stderr.split("\n").slice(0, 5).map((l) => `  | ${l}`).join("\n"),
      );
      append(cfg.tsvPath, makeRow(n, "discard", null, null, ideate, "ideate-fail"));
      continue;
    }
    setStage(1, "done");

    // Apply the patch ─────────────────────────────────────────────────────
    loopState.phase = `iter ${n}: stage 2 (apply)`;
    setStage(2, "running");
    console.error(`[iter ${n}] stage 2: git apply (${ideate.stdout.length}B patch)`);
    const patchTag = `AR_EOF_${rand()}`;
    const apply = await runWithStageLog(
      term, cfg.workdir, 2, n,
      // LLM diffs are fragile 3 ways: bogus @@ counts, hallucinated start
      // lines, and context drift. Cascade: (1) exact `git apply --recount`
      // (fast path for well-formed diffs, least misplacement risk); else
      // (2) recount_diff.py fixes the @@ counts so the patch parses, then
      // GNU `patch --fuzz=3` ignores the bogus start line and relocates the
      // hunk by context. Build+verify+scope-guard downstream discard any
      // mis-fuzzed result, so tolerance here is safe.
      `cat > .ar.patch <<'${patchTag}'\n${ideate.stdout}\n${patchTag}\n` +
      `( git apply --recount --check .ar.patch && git apply --recount .ar.patch ) || ` +
      `( python3 ${RECOUNT} < .ar.patch > .ar.recount.patch && ` +
      `patch -p1 --fuzz=3 --no-backup-if-mismatch -s < .ar.recount.patch )`,
    );
    if (apply.exitCode !== 0) {
      setStage(2, "error");
      console.error(
        `[iter ${n}] stage 2 FAIL — git stderr:\n` +
        apply.stderr.split("\n").slice(0, 5).map((l) => `  | ${l}`).join("\n") +
        `\n[iter ${n}] stage 2 FAIL — patch first 5 lines:\n` +
        ideate.stdout.split("\n").slice(0, 5).map((l) => `  | ${l}`).join("\n") +
        `\n[iter ${n}] stage 2 FAIL — patch last 5 lines:\n` +
        ideate.stdout.split("\n").slice(-5).map((l) => `  | ${l}`).join("\n"),
      );
      append(cfg.tsvPath, makeRow(n, "discard", null, null, apply, "apply-fail"));
      continue;
    }
    setStage(2, "done");
    console.error(`[iter ${n}] stage 2: apply OK`);

    // Scope guard ─────────────────────────────────────────────────────────
    const diff    = await term.run("git diff --name-only");
    const changed = diff.stdout.split("\n").filter(Boolean);

    if (!changed.every((f) => cfg.scope.some((s) => f.startsWith(s)))) {
      await term.run("git checkout -- . && git clean -fd");
      append(cfg.tsvPath, makeRow(n, "discard", null, null, diff, "out-of-scope"));
      continue;
    }
    if (changed.length === 0) {
      append(cfg.tsvPath, makeRow(n, "no-op", null, null, diff, "no-op"));
      continue;
    }

    // 4. Commit BEFORE verify ─────────────────────────────────────────────
    // Add ONLY the scope-validated changed files. `git add -A` would also
    // try to add unrelated workdir state (e.g. broken submodule paths in
    // /home/fxy/angle/_bad_scm/...), which kills the session.
    const addArgs = changed
      .map((f) => `'${f.replace(/'/g, `'\\''`)}'`)
      .join(" ");
    await runOrDie(term, `git add -- ${addArgs} && git commit -m "experiment: iter ${n}"`);

    // 5a. Guard ───────────────────────────────────────────────────────────
    loopState.phase = `iter ${n}: stage 3 (build)`;
    setStage(3, "running");
    console.error(`[iter ${n}] stage 3: guardCmd (build)`);
    const guard = await runWithStageLog(term, cfg.workdir, 3, n, cfg.guardCmd, 20 * 60_000);
    console.error(`[iter ${n}] stage 3: build exit=${guard.exitCode} (${guard.durationMs}ms)`);
    if (guard.exitCode !== 0) {
      setStage(3, "error");
      const diagDesc = await runDiag(term, cfg.diagCmd);
      console.error(`[iter ${n}] stage 3 FAIL — diag: ${diagDesc || "(none)"}`);
      await term.run("git revert --no-edit HEAD");
      append(cfg.tsvPath, makeRow(n, "discard", null, null, guard, `build-fail${diagDesc}`));
      continue;
    }
    setStage(3, "done");

    // 5b. Verify ──────────────────────────────────────────────────────────
    loopState.phase = `iter ${n}: stage 4 (verify)`;
    setStage(4, "running");
    console.error(`[iter ${n}] stage 4: verifyCmd (metric)`);
    const v      = await runWithStageLog(term, cfg.workdir, 4, n, cfg.verifyCmd, 30 * 60_000);
    const metric = parseMetric(v);
    console.error(
      `[iter ${n}] stage 4: verify exit=${v.exitCode} metric=${metric} ` +
      `stdout="${v.stdout.slice(-80)}" (${v.durationMs}ms)`,
    );

    if (metric === null || v.exitCode !== 0) {
      setStage(4, "error");
      const diagDesc = await runDiag(term, cfg.diagCmd);
      console.error(`[iter ${n}] stage 4 FAIL — diag: ${diagDesc || "(none)"}`);
      await term.run("git revert --no-edit HEAD");
      append(cfg.tsvPath, makeRow(n, "crash", null, null, v, `verify-bad${diagDesc}`));
      if (++metricErrors >= 2) {
        console.error("[autoresearch] 2× metric-error — exiting session");
        return;
      }
      continue;
    }
    setStage(4, "done");
    metricErrors = 0;

    // 6. Decide ───────────────────────────────────────────────────────────
    setStage(5, "running");
    const better = cfg.direction === "lower" ? metric < best! : metric > best!;

    // Dry-run: always revert and leave best/sinceBest untouched. The TSV row
    // (remapped to status="dry-run" in makeRow) preserves what *would* have
    // happened in `desc`.
    if (runtime.dryRun) {
      await term.run("git revert --no-edit HEAD");
      console.error(`[autoresearch] dry-run  metric=${metric}  would=${better ? "keep" : "discard"}`);
      append(cfg.tsvPath, makeRow(n, "keep", metric, null, v, `would-${better ? "keep" : "discard"}`));
      continue;
    }

    let decisionStdout: string;
    if (better) {
      const oldBest = best!;
      const delta   = metric - oldBest;
      best          = metric;
      sinceBest     = 0;
      console.error(`[autoresearch] ✓ keep  metric=${metric}  delta=${delta}`);
      append(cfg.tsvPath, makeRow(n, "keep", metric, delta, v, "keep"));
      setStage(5, "done");
      decisionStdout = `decision: keep\nmetric: ${metric}\ndelta: ${delta}\nbest (new): ${best}\nbest (old): ${oldBest}\n`;
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

    if (sinceBest >= cfg.plateauPatience) {
      console.error(`[autoresearch] plateau ${sinceBest}/${cfg.plateauPatience} — exiting session`);
      loopState.phase = "plateau";
      return;
    }
  }

  console.error("[autoresearch] iterations exhausted — session done");
  loopState.phase = "done";
}
