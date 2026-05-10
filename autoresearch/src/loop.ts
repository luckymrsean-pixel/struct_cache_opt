import { Terminal, CmdResult } from "./terminal";
import { ensure, append, tail, bestSoFar, Row } from "./logger";
import { Config } from "./config";

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
  for (const cmd of cfg.setupCmds ?? []) {
    console.error(`[autoresearch] setup: ${cmd}`);
    await runOrDie(term, cmd);
  }

  // Baseline (skipped if TSV already has one from a prior session).
  let best = bestSoFar(cfg.tsvPath, cfg.direction);
  if (best === null) {
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
      return;
    }
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
    const ideate = await term.run(
      `${ideateCmd} <<'${heredocTag}'\n${ctxBody}\n${heredocTag}`,
      10 * 60_000,
    );

    if (ideate.exitCode !== 0 || !ideate.stdout.trim()) {
      append(cfg.tsvPath, makeRow(n, "discard", null, null, ideate, "ideate-fail"));
      continue;
    }

    // Apply the patch ─────────────────────────────────────────────────────
    const patchTag = `AR_EOF_${rand()}`;
    const apply = await term.run(
      `cat > .ar.patch <<'${patchTag}'\n${ideate.stdout}\n${patchTag}\n` +
      `git apply --check .ar.patch && git apply .ar.patch`,
    );
    if (apply.exitCode !== 0) {
      append(cfg.tsvPath, makeRow(n, "discard", null, null, apply, "apply-fail"));
      continue;
    }

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
    await runOrDie(term, `git add -A && git commit -m "experiment: iter ${n}"`);

    // 5a. Guard ───────────────────────────────────────────────────────────
    const guard = await term.run(cfg.guardCmd, 20 * 60_000);
    if (guard.exitCode !== 0) {
      const diagDesc = await runDiag(term, cfg.diagCmd);
      await term.run("git revert --no-edit HEAD");
      append(cfg.tsvPath, makeRow(n, "discard", null, null, guard, `build-fail${diagDesc}`));
      continue;
    }

    // 5b. Verify ──────────────────────────────────────────────────────────
    const v      = await term.run(cfg.verifyCmd, 30 * 60_000);
    const metric = parseMetric(v);

    if (metric === null || v.exitCode !== 0) {
      const diagDesc = await runDiag(term, cfg.diagCmd);
      await term.run("git revert --no-edit HEAD");
      append(cfg.tsvPath, makeRow(n, "crash", null, null, v, `verify-bad${diagDesc}`));
      if (++metricErrors >= 2) {
        console.error("[autoresearch] 2× metric-error — exiting session");
        return;
      }
      continue;
    }
    metricErrors = 0;

    // 6. Decide ───────────────────────────────────────────────────────────
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

    if (better) {
      const delta = metric - best!;
      best        = metric;
      sinceBest   = 0;
      console.error(`[autoresearch] ✓ keep  metric=${metric}  delta=${delta}`);
      append(cfg.tsvPath, makeRow(n, "keep", metric, delta, v, "keep"));
    } else {
      await term.run("git revert --no-edit HEAD");
      sinceBest++;
      console.error(`[autoresearch] ✗ discard  metric=${metric}  best=${best}`);
      append(cfg.tsvPath, makeRow(n, "discard", metric, metric - best!, v, "regress"));
    }

    if (sinceBest >= cfg.plateauPatience) {
      console.error(`[autoresearch] plateau ${sinceBest}/${cfg.plateauPatience} — exiting session`);
      return;
    }
  }

  console.error("[autoresearch] iterations exhausted — session done");
}
