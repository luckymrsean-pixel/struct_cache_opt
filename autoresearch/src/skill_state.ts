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

function freshEmpty(): SkillState {
  return {
    manifest: { frozen: [], evolving: [] },
    current:  { head: "", tag: "" },
    champion: { head: "", tag: "" },
    diff:     [],
  };
}

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
  if (!skillDir || !existsSync(skillDir)) return freshEmpty();
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
