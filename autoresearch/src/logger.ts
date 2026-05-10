import { existsSync, appendFileSync, readFileSync, writeFileSync } from "fs";

// TSV columns: iter  status  metric  delta  exit  warns  desc  ts
// status:      baseline | keep | discard | no-op | crash | dry-run

export interface Row {
  iter:   number;
  status: "baseline" | "keep" | "discard" | "no-op" | "crash" | "dry-run";
  metric: number | null;
  delta:  number | null;
  exit:   number;
  warns:  number;
  desc:   string;
  ts:     string;
}

const HEADER = "iter\tstatus\tmetric\tdelta\texit\twarns\tdesc\tts";

export function ensure(path: string, direction = "lower"): void {
  if (!existsSync(path)) {
    writeFileSync(path, `# direction=${direction}\n${HEADER}\n`, "utf8");
  }
}

export function append(path: string, row: Row): void {
  const line = [
    row.iter,
    row.status,
    row.metric ?? "",
    row.delta  ?? "",
    row.exit,
    row.warns,
    row.desc,
    row.ts,
  ].join("\t");
  appendFileSync(path, line + "\n", "utf8");
}

export function tail(path: string, n: number): string {
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return lines.slice(-n).join("\n");
}

export function bestSoFar(
  path: string,
  dir: "lower" | "higher",
): number | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("#") && l.trim() && !l.startsWith("iter"));

  let best: number | null = null;
  for (const line of lines) {
    const cols   = line.split("\t");
    const status = cols[1];
    if (status !== "keep" && status !== "baseline") continue;
    const m = Number(cols[2]);
    if (!isFinite(m)) continue;
    if (best === null)                           best = m;
    else if (dir === "lower"  && m < best)       best = m;
    else if (dir === "higher" && m > best)       best = m;
  }
  return best;
}
