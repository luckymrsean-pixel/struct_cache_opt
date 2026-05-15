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

function deepEq(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${label}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

async function main(): Promise<void> {
  // ── Fixture ──────────────────────────────────────────────────────────────
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

  // ── Tests ────────────────────────────────────────────────────────────────

  await test("readManifest parses frozen + evolving", () => {
    const m = readManifest(dir);
    deepEq("frozen",   m.frozen,   ["SKILL.md", "run.sh"]);
    deepEq("evolving", m.evolving, ["prompt.tmpl", "inputs/rules.MD"]);
  });

  await test("getSkillState partitions correctly", () => {
    const s = getSkillState(dir);
    deepEq("manifest.frozen",   s.manifest.frozen,   ["SKILL.md", "run.sh"]);
    deepEq("manifest.evolving", s.manifest.evolving, ["prompt.tmpl", "inputs/rules.MD"]);
    if (s.current.head !== headSha)          throw new Error(`current head ${s.current.head} != ${headSha}`);
    if (s.champion.head !== championSha)     throw new Error(`champion head ${s.champion.head} != ${championSha}`);
    if (s.diff.length !== 1)                 throw new Error(`diff length ${s.diff.length}`);
    if (s.diff[0].path !== "prompt.tmpl")    throw new Error(`diff path ${s.diff[0].path}`);
    if (s.diff[0].added !== 3)               throw new Error(`diff added ${s.diff[0].added}`);
    if (s.diff[0].removed !== 1)             throw new Error(`diff removed ${s.diff[0].removed}`);
  });

  await test("getSkillDiff returns unified diff", () => {
    const d = getSkillDiff(dir, "prompt.tmpl");
    if (!d.includes("-v1 prompt")) throw new Error(`expected -v1 prompt in:\n${d}`);
    if (!d.includes("+v2 prompt")) throw new Error(`expected +v2 prompt in:\n${d}`);
  });

  await test("getSkillShow returns champion-tag content", () => {
    const c = getSkillShow(dir, "champion", "prompt.tmpl");
    if (c.trim() !== "v1 prompt") throw new Error(`expected v1 prompt, got: ${JSON.stringify(c)}`);
  });

  await test("getSkillState handles missing skillDir gracefully", () => {
    const s = getSkillState(undefined);
    deepEq("frozen",   s.manifest.frozen,   []);
    deepEq("evolving", s.manifest.evolving, []);
    deepEq("diff",     s.diff,              []);
  });

  await test("getSkillState handles dir without MANIFEST.yml", () => {
    const empty = mkdtempSync(join(tmpdir(), "ar-empty-"));
    execSync("git init -q", { cwd: empty });
    const s = getSkillState(empty);
    deepEq("frozen",   s.manifest.frozen,   []);
    deepEq("evolving", s.manifest.evolving, []);
    rmSync(empty, { recursive: true, force: true });
  });

  await test("getSkillState handles git repo without champion tag", () => {
    const fresh = mkdtempSync(join(tmpdir(), "ar-nochamp-"));
    writeFileSync(join(fresh, "MANIFEST.yml"), "frozen:\n  - SKILL.md\nevolving:\n  - prompt.tmpl\n");
    writeFileSync(join(fresh, "SKILL.md"),    "x\n");
    writeFileSync(join(fresh, "prompt.tmpl"), "y\n");
    const G2 = (cmd: string) => execSync(cmd, { cwd: fresh, encoding: "utf8" }).trim();
    G2("git init -q");
    G2("git -c user.email=t@t -c user.name=t add -A");
    G2("git -c user.email=t@t -c user.name=t commit -q -m initial");
    // Note: no `git tag champion` — this is the "fresh skill repo" scenario.
    const s = getSkillState(fresh);
    if (s.manifest.frozen.length   !== 1) throw new Error(`frozen len ${s.manifest.frozen.length}`);
    if (s.manifest.evolving.length !== 1) throw new Error(`evolving len ${s.manifest.evolving.length}`);
    if (s.current.head === "")            throw new Error("current.head should be set");
    if (s.champion.head !== "")           throw new Error(`champion.head should be empty, got ${s.champion.head}`);
    if (s.diff.length !== 0)              throw new Error(`diff should be empty, got len ${s.diff.length}`);
    rmSync(fresh, { recursive: true, force: true });
  });

  await test("skillDir is a SUBDIRECTORY of the git repo (real meta-loop topology)", () => {
    // Regression: the real skill repo is target_skill/ (git root) but skillDir
    // is target_skill/struct_layout_opt/. git show <ref>:<path> resolves <path>
    // from the repo ROOT, and `git diff --numstat` (no --relative) emits
    // repo-root paths — both break MANIFEST-relative lookups. Prior fixtures
    // built the repo AT skillDir so this never got exercised.
    const root = mkdtempSync(join(tmpdir(), "ar-subdir-"));
    const sub  = join(root, "struct_layout_opt");
    mkdirSync(join(sub, "inputs"), { recursive: true });
    writeFileSync(join(sub, "MANIFEST.yml"),
      "frozen:\n  - SKILL.md\nevolving:\n  - prompt.tmpl\n  - inputs/rules.MD\n");
    writeFileSync(join(sub, "SKILL.md"),        "frozen content\n");
    writeFileSync(join(sub, "prompt.tmpl"),     "champion prompt\n");
    writeFileSync(join(sub, "inputs/rules.MD"), "champion rules\n");
    // Unrelated file OUTSIDE the skill subdir — must NOT leak into diff/state.
    writeFileSync(join(root, "README.md"),      "repo root readme\n");
    const G3 = (cmd: string) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
    G3("git init -q");
    G3("git -c user.email=t@t -c user.name=t add -A");
    G3("git -c user.email=t@t -c user.name=t commit -q -m initial");
    G3("git tag champion");
    // Candidate change: edit an evolving file in the subdir.
    writeFileSync(join(sub, "prompt.tmpl"), "candidate prompt\nline2\n");
    G3("git -c user.email=t@t -c user.name=t add -A");
    G3("git -c user.email=t@t -c user.name=t commit -q -m candidate");

    const s = getSkillState(sub);
    // diff must report the subdir-relative path, matching MANIFEST entries.
    if (s.diff.length !== 1)              throw new Error(`diff len ${s.diff.length} (expected 1: prompt.tmpl)`);
    if (s.diff[0].path !== "prompt.tmpl") throw new Error(`diff path ${s.diff[0].path} (expected prompt.tmpl, not struct_layout_opt/prompt.tmpl)`);
    if (s.diff[0].added !== 2)            throw new Error(`diff added ${s.diff[0].added}`);

    // getSkillShow must resolve subdir-relative paths against champion.
    const shown = getSkillShow(sub, "champion", "prompt.tmpl");
    if (shown.trim() !== "champion prompt") throw new Error(`show champion:prompt.tmpl => ${JSON.stringify(shown)}`);
    const frozenShown = getSkillShow(sub, "champion", "SKILL.md");
    if (frozenShown.trim() !== "frozen content") throw new Error(`show champion:SKILL.md => ${JSON.stringify(frozenShown)}`);

    // getSkillDiff must return a non-empty unified diff for the changed file.
    const d = getSkillDiff(sub, "prompt.tmpl");
    if (!d.includes("-champion prompt")) throw new Error(`getSkillDiff missing old line:\n${d}`);
    if (!d.includes("+candidate prompt")) throw new Error(`getSkillDiff missing new line:\n${d}`);

    rmSync(root, { recursive: true, force: true });
  });

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
