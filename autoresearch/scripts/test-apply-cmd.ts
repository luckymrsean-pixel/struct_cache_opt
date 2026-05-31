/**
 * Regression guards for the Stage-2 "apply diff" command.
 *
 * 1. buildApplyCmd() must never let the apply stage block the PTY. When
 *    `git apply` rejects a patch (already-applied / reversed / non-matching —
 *    what a stale dummy diff looks like) the loop falls back to GNU `patch`.
 *    GNU `patch` DOES print interactive prompts ("Reversed (or previously
 *    applied) patch detected!  Assume -R?" / "File to patch:"), but because
 *    the patch is fed via `< .ar.recount.patch`, patch reads the prompt
 *    ANSWERS from that same redirected file, hits EOF, takes the default, and
 *    exits non-zero fast — it never reads /dev/tty, so it never hangs. This
 *    test locks that property in (probed across already-applied / missing-
 *    file / no-context / garbage during root-cause analysis).
 *
 * 2. Even so, term.run() can still reject (real timeout / dead terminal).
 *    runWithStageLog() must then close the stage log with a failure footer so
 *    the dashboard shows the stage errored instead of freezing on a half-open
 *    "# begin"-only file.
 *
 * Run: tsx scripts/test-apply-cmd.ts
 */

import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Terminal } from "../src/terminal";
import { buildApplyCmd, runWithStageLog } from "../src/loop";
import { stageLogPath } from "../src/stage_log";
import { readFileSync } from "fs";

const RECOUNT = join(__dirname, "..", "..", "scripts", "recount_diff.py");

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A temp git repo whose tracked file ALREADY contains the patched line, plus
 *  the unified diff that (re-)adds it. `git apply` will reject this diff
 *  (already applied) → forces the GNU `patch` fallback path. */
function makeAlreadyAppliedRepo(): { dir: string; patch: string } {
  const dir = mkdtempSync(join(tmpdir(), "ar-apply-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "t.txt"), "alpha\nbravo\ncharlie\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  // Make + record the patch, then commit it so the tree already has the line.
  writeFileSync(join(dir, "t.txt"), "alpha\nbravo\nINSERTED\ncharlie\n");
  const patch = git(dir, ["diff", "--", "t.txt"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "applied"]);
  return { dir, patch };
}

async function main(): Promise<void> {
  // ── 1. apply-diff cannot hang the loop on an unappliable patch ──────────────
  await test("buildApplyCmd terminates (non-zero) on already-applied patch — no PTY hang", async () => {
    const { dir, patch } = makeAlreadyAppliedRepo();
    const term = new Terminal();
    await term.start();
    try {
      await term.run(`cd ${dir}`);
      const cmd = buildApplyCmd(patch, `AR_EOF_test`, RECOUNT);
      // A regression that reintroduced a /dev/tty prompt read would block
      // until this timeout; the correct command finishes in well under 1s.
      const r = await term.run(cmd, 15_000);
      if (r.exitCode === 0)
        throw new Error("expected non-zero exit (patch already applied), got 0");
    } finally {
      term.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── 2. runWithStageLog closes the stage log even when term.run throws ───────
  // (timeout / dead terminal) so the dashboard never shows a frozen stage.
  await test("runWithStageLog writes a stage-log tail when term.run throws", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "ar-stagelog-"));
    const boom = new Error("run() timed out after 1ms");
    const fakeTerm = {
      run: async () => { throw boom; },
    } as unknown as Terminal;
    let threw = false;
    try {
      await runWithStageLog(fakeTerm, workdir, 2, 9, "patch …", 1);
    } catch (e) {
      threw = true;
      if (e !== boom) throw new Error(`rethrew wrong error: ${String(e)}`);
    }
    if (!threw) throw new Error("expected runWithStageLog to rethrow term.run error");
    const log = readFileSync(stageLogPath(workdir, 2), "utf8");
    if (!/# exit=\d+ {2}duration=\d+ms {2}end/.test(log))
      throw new Error(`stage log left half-open (no end footer):\n${log}`);
    if (!log.includes("run() timed out"))
      throw new Error(`stage log missing the error reason:\n${log}`);
    rmSync(workdir, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error("[test-apply-cmd] fatal:", e);
  process.exit(1);
});
