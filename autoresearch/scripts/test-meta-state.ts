/**
 * Unit tests for meta_state helpers — meta_results.tsv parsing + driver
 * liveness + run detail. Uses throwaway temp dirs; no dependency on the real
 * meta-runs/ state.
 * Run: tsx scripts/test-meta-state.ts
 */
import { writeFileSync, mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseMetaState, getMetaRun } from "../src/meta_state";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗  ${name}\n     ${msg}`);
    failed++;
  }
}

function eq(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const TSV =
  "# direction=multi  primary=M1  baseline_tag=meta-baseline\n" +
  "meta_iter\tskill_tag\tparent_tag\teval_N\tM1_total_drop\tM2_apply_rate\t" +
  "M3_keep_rate\tM4_struct_cov\tM5_cv\tdecision\treason\tts\trun_dir\n" +
  "0\tskill-v0\tskill-v0\t2\t0\t50%\t0%\t0\tn/a\tmanual\twithin noise band\t2026-05-14T11:20:06Z\tmeta-runs/skill-v0\n" +
  "1\tskill-v3\tskill-v0\t3\t13244864\t67%\t67%\t1\t0.732\tadvance\tM1 +12% over champion\t2026-05-16T01:00:00Z\tmeta-runs/skill-v3\n";

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "ar-meta-state-"));
  writeFileSync(join(dir, "meta_results.tsv"), TSV);
  mkdirSync(join(dir, "meta-runs"), { recursive: true });
  writeFileSync(join(dir, "meta-runs", "driver.log"),
    "[2026-05-16T00:59:00Z] ── meta-iter 1/3 ──\n" +
    "[2026-05-16T01:00:10Z] meta-iter 1 done: skill-v3 decision=advance M1=13244864\n");

  // Use a bogus skill repo so resolveChampion degrades to "" (no throw).
  const st = parseMetaState(dir, join(dir, "no-such-repo"));

  test("parses two data rows, skips # + header", () => {
    eq("row count", st.rows.length, 2);
  });
  test("row fields mapped by column", () => {
    eq("r1 skill_tag", st.rows[1].skill_tag, "skill-v3");
    eq("r1 M1", st.rows[1].M1, "13244864");
    eq("r1 decision", st.rows[1].decision, "advance");
    eq("r0 reason", st.rows[0].reason, "within noise band");
  });
  test("champion degrades to '' on bad repo (no throw)", () => {
    eq("champion", st.champion, "");
  });
  test("driverRunning false when no pid file", () => {
    eq("driverRunning", st.driverRunning, false);
  });
  test("lastDriverLine = last non-empty driver.log line", () => {
    eq("last", st.lastDriverLine,
       "[2026-05-16T01:00:10Z] meta-iter 1 done: skill-v3 decision=advance M1=13244864");
  });

  // getMetaRun
  const rd = join(dir, "meta-runs", "skill-v3");
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, "result.json"),
    JSON.stringify({ M1_total_drop: 13244864, decision: "advance" }));
  writeFileSync(join(rd, "autoresearch.log"), "line1\nline2\nline3\n");

  test("getMetaRun returns parsed result + log tail", () => {
    const r = getMetaRun(dir, "skill-v3");
    if (!r) throw new Error("null run detail");
    eq("M1", (r.result as Record<string, unknown>).M1_total_drop, 13244864);
    if (!r.logTail.includes("line3")) throw new Error("log tail missing");
  });
  test("getMetaRun rejects path-traversal tag", () => {
    eq("traversal", getMetaRun(dir, "../../etc"), null);
  });
  test("getMetaRun null for unknown tag", () => {
    eq("unknown", getMetaRun(dir, "skill-v999"), null);
  });
  test("empty cacheRoot → empty view, no throw", () => {
    const e = parseMetaState(mkdtempSync(join(tmpdir(), "ar-empty-")),
                             join(dir, "nope"));
    eq("rows", e.rows.length, 0);
    eq("type", e.type, "meta-state");
  });

  console.log(`\nmeta-state: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
