/**
 * src/meta_state.ts — read-only view of the Phase-2 meta-loop evolution.
 *
 * Sources (all on disk, written by meta_decide.py / meta-driver.sh):
 *   - <cacheRoot>/meta_results.tsv         human lineage table
 *   - <cacheRoot>/meta-runs/<tag>/result.json   machine M1..M5 + decision
 *   - <cacheRoot>/meta-runs/<tag>/autoresearch.log  inner-iter detail
 *   - <cacheRoot>/meta-runs/driver.log     one line per meta-iter
 *   - <cacheRoot>/meta-driver.pid          present+alive ⇒ driver running
 *
 * Pure reader: never mutates, never throws (degrades to an empty view).
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface MetaRow {
  meta_iter:  string;
  skill_tag:  string;
  parent_tag: string;
  eval_N:     string;
  M1:         string;
  M2:         string;
  M3:         string;
  M4:         string;
  M5:         string;
  decision:   string;
  reason:     string;
  ts:         string;
  run_dir:    string;
}

export interface MetaState {
  type:           "meta-state";
  rows:           MetaRow[];
  champion:       string;       // resolved version tag pointed at by `champion`
  driverRunning:  boolean;
  lastDriverLine: string;
}

const COLS: (keyof MetaRow)[] = [
  "meta_iter", "skill_tag", "parent_tag", "eval_N",
  "M1", "M2", "M3", "M4", "M5",
  "decision", "reason", "ts", "run_dir",
];

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Resolve which version tag (skill-v<N>) the floating `champion` tag is on. */
function resolveChampion(skillRepo: string): string {
  try {
    const out = execFileSync(
      "git", ["-C", skillRepo, "tag", "--points-at", "champion"],
      { encoding: "utf8" },
    );
    const tag = out.split("\n").map((s) => s.trim())
      .find((s) => s && s !== "champion");
    if (tag) return tag;
    return execFileSync(
      "git", ["-C", skillRepo, "rev-parse", "--short", "champion"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

export function parseMetaState(cacheRoot: string, skillRepo: string): MetaState {
  const empty: MetaState = {
    type: "meta-state", rows: [], champion: "",
    driverRunning: false, lastDriverLine: "",
  };

  const tsvPath = join(cacheRoot, "meta_results.tsv");
  const rows: MetaRow[] = [];
  if (existsSync(tsvPath)) {
    for (const raw of readFileSync(tsvPath, "utf8").split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim() || line.startsWith("#")) continue;
      const cells = line.split("\t");
      if (cells[0] === "meta_iter") continue;   // column-header row
      const row = {} as MetaRow;
      COLS.forEach((c, i) => { row[c] = cells[i] ?? ""; });
      rows.push(row);
    }
  }

  const driverPid = join(cacheRoot, "meta-driver.pid");
  let driverRunning = false;
  if (existsSync(driverPid)) {
    const pid = Number(readFileSync(driverPid, "utf8").trim());
    driverRunning = Number.isFinite(pid) && pidAlive(pid);
  }

  let lastDriverLine = "";
  const dlog = join(cacheRoot, "meta-runs", "driver.log");
  if (existsSync(dlog)) {
    const lines = readFileSync(dlog, "utf8").split("\n").filter((l) => l.trim());
    lastDriverLine = lines[lines.length - 1] ?? "";
  }

  return {
    ...empty,
    rows,
    champion: resolveChampion(skillRepo),
    driverRunning,
    lastDriverLine,
  };
}

export interface MetaRunDetail {
  tag:     string;
  result:  unknown;        // parsed result.json or null
  logTail: string;         // last ~200 lines of autoresearch.log
}

export function getMetaRun(cacheRoot: string, tag: string): MetaRunDetail | null {
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) return null;     // path-safety
  const dir = join(cacheRoot, "meta-runs", tag);
  if (!existsSync(dir)) return null;
  let result: unknown = null;
  const rj = join(dir, "result.json");
  if (existsSync(rj)) {
    try { result = JSON.parse(readFileSync(rj, "utf8")); } catch { result = null; }
  }
  let logTail = "";
  const al = join(dir, "autoresearch.log");
  if (existsSync(al)) {
    logTail = readFileSync(al, "utf8").split("\n").slice(-200).join("\n");
  }
  return { tag, result, logTail };
}
