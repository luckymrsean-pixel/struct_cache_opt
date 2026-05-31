/**
 * Regression tests for dry-run dummy-diff auto-generation.
 *
 * Root cause of "dry run 卡死在 apply diff": the dashboard's Dry Run toggle
 * substitutes `cat <dryRunPatch>` for the LLM, but NOTHING ever creates that
 * patch (how-to.md claims it "已存在" — it does not). With no diff, Stage-1
 * fails every iter and the "apply diff" stage log never advances, so the
 * operator sees it frozen.
 *
 * dryRunIdeateCmd() must, each iter, emit a guaranteed-valid, UNIQUE unified
 * diff against the first scope file so Stage 2→5 (apply→build→verify→decide)
 * actually runs without the LLM. It must leave the working tree clean (the
 * loop's own Stage-2 does the applying) and never block.
 *
 * Run: tsx scripts/test-dry-run.ts
 */

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Terminal } from "../src/terminal";
import { dryRunIdeateCmd } from "../src/loop";
import type { Config } from "../src/config";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (e) { console.error(`  ✗  ${name}\n     ${e instanceof Error ? e.message : e}`); failed++; }
}

function git(cwd: string, a: string[]): string {
  return execFileSync("git", a, { cwd, encoding: "utf8" });
}

function makeRepo(): { dir: string; scope: string } {
  const dir = mkdtempSync(join(tmpdir(), "ar-dryrun-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  const scope = "src/vk_helpers.h";
  writeFileSync(join(dir, scope), "// header\nstruct X { int a; int b; };\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return { dir, scope };
}

function cfgFor(dir: string, scope: string): Config {
  return {
    scope: [scope],
    workdir: dir,
    dryRunPatch: join(dir, "dry.patch"),
  } as unknown as Config;
}

/** Run a generation command via the real PTY from inside `dir`. */
async function gen(dir: string, cmd: string): Promise<string> {
  const term = new Terminal();
  await term.start();
  try {
    await term.run(`cd ${dir}`);
    const r = await term.run(cmd, 15_000);
    if (r.exitCode !== 0) throw new Error(`gen cmd exit ${r.exitCode}: ${r.stderr}`);
    return r.stdout;
  } finally {
    term.dispose();
  }
}

async function main(): Promise<void> {
  await test("emits a valid unified diff against the first scope file", async () => {
    const { dir, scope } = makeRepo();
    try {
      const out = await gen(dir, dryRunIdeateCmd(cfgFor(dir, scope), 7));
      if (!out.trim()) throw new Error("empty stdout — no dummy diff produced");
      if (!out.includes(`--- a/${scope}`) || !out.includes(`+++ b/${scope}`))
        throw new Error(`diff does not target ${scope}:\n${out}`);
      if (!/ar-dry-run iter 7\b/.test(out))
        throw new Error(`diff missing unique iter marker:\n${out}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test("leaves the working tree clean (loop's Stage-2 does the applying)", async () => {
    const { dir, scope } = makeRepo();
    try {
      await gen(dir, dryRunIdeateCmd(cfgFor(dir, scope), 3));
      const status = git(dir, ["status", "--porcelain"]).trim();
      // Only the generated patch file (untracked) may remain; the scope file
      // and any *.bak must be gone/unmodified.
      const dirty = status.split("\n").filter(Boolean)
        .filter((l) => !l.endsWith("dry.patch"));
      if (dirty.length) throw new Error(`working tree not restored:\n${status}`);
      if (existsSync(join(dir, `${scope}.ar-dryrun-bak`)))
        throw new Error("backup file left behind");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test("the produced patch applies cleanly with git apply", async () => {
    const { dir, scope } = makeRepo();
    try {
      await gen(dir, dryRunIdeateCmd(cfgFor(dir, scope), 5));
      // The generation restores the file, so the saved patch must re-apply.
      git(dir, ["apply", "--recount", "--check", join(dir, "dry.patch")]);
    } catch (e) {
      throw new Error(`git apply --check failed on the generated patch: ${e instanceof Error ? e.message : e}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test("successive iters produce DIFFERENT patches (never 'already applied')", async () => {
    const { dir, scope } = makeRepo();
    try {
      const a = await gen(dir, dryRunIdeateCmd(cfgFor(dir, scope), 1));
      const b = await gen(dir, dryRunIdeateCmd(cfgFor(dir, scope), 2));
      if (a === b) throw new Error("iter 1 and iter 2 produced identical patches");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test("empty scope fails cleanly (non-zero, no hang) instead of silently no-op", async () => {
    const { dir } = makeRepo();
    const term = new Terminal();
    await term.start();
    try {
      await term.run(`cd ${dir}`);
      const r = await term.run(dryRunIdeateCmd({ scope: [], workdir: dir } as unknown as Config, 1), 8000);
      if (r.exitCode === 0) throw new Error("expected non-zero exit for empty scope");
    } finally { term.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[test-dry-run] fatal:", e); process.exit(1); });
