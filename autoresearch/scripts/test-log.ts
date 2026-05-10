/**
 * M2 — logger.ts 单元测试
 *
 * 验收：
 *   ✓ ensure() 创建文件 + 写入 header
 *   ✓ append 3 行后可读回
 *   ✓ bestSoFar(lower) 返回最小值
 *   ✓ bestSoFar(higher) 返回最大值
 *   ✓ bestSoFar 只计 baseline / keep 行
 *   ✓ tail(n) 取末 n 行
 *   ✓ tail(n) 超出总行数不报错
 */

import { existsSync, unlinkSync } from "fs";
import { ensure, append, tail, bestSoFar, Row } from "../src/logger";

const TMP = `/tmp/autoresearch-test-logger-${Date.now()}.tsv`;

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

function cleanup(): void {
  if (existsSync(TMP)) unlinkSync(TMP);
}

// Dummy CmdResult fields
function fakeRow(
  iter:   number,
  status: Row["status"],
  metric: number | null,
  delta:  number | null,
  desc:   string,
): Row {
  return { iter, status, metric, delta, exit: 0, warns: 0, desc, ts: new Date().toISOString() };
}

// ─── tests ────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("\n=== logger.ts tests ===\n");
  cleanup();

  test("ensure() creates file when absent", () => {
    ensure(TMP, "lower");
    if (!existsSync(TMP)) throw new Error("file not created");
  });

  test("ensure() is idempotent (no throw on second call)", () => {
    ensure(TMP, "lower");   // already exists
  });

  test("append() 3 rows without error", () => {
    append(TMP, fakeRow(0, "baseline", 100,  null,  "initial"));
    append(TMP, fakeRow(1, "keep",      85,  -15,   "keep"));
    append(TMP, fakeRow(2, "discard",   92,   7,    "regress"));
  });

  test("bestSoFar(lower) = 85  (only baseline + keep counted)", () => {
    const b = bestSoFar(TMP, "lower");
    eq("best", b, 85);
  });

  test("bestSoFar(higher) = 100  (only baseline + keep counted)", () => {
    const b = bestSoFar(TMP, "higher");
    eq("best", b, 100);
  });

  test("discard rows excluded from bestSoFar", () => {
    // iter=2 metric=92 is discard — must not be returned as higher best
    const b = bestSoFar(TMP, "higher");
    if (b === 92) throw new Error("discard row incorrectly included");
  });

  test("tail(2) returns last 2 data lines", () => {
    const t = tail(TMP, 2);
    const lines = t.split("\n").filter(Boolean);
    if (lines.length !== 2) throw new Error(`got ${lines.length} lines`);
  });

  test("tail last line contains 'regress'", () => {
    const t = tail(TMP, 1);
    if (!t.includes("regress")) throw new Error(`line: ${t}`);
  });

  test("tail(999) does not throw when fewer rows exist", () => {
    const t = tail(TMP, 999);
    if (typeof t !== "string") throw new Error("expected string");
  });

  test("bestSoFar returns null for non-existent file", () => {
    const b = bestSoFar("/tmp/does-not-exist-autoresearch.tsv", "lower");
    eq("null", b, null);
  });

  // Add a second keep row, verify best updates
  test("bestSoFar updates after appending better keep row", () => {
    append(TMP, fakeRow(3, "keep", 70, -15, "keep"));
    const b = bestSoFar(TMP, "lower");
    eq("best", b, 70);
  });

  cleanup();

  const total = passed + failed;
  console.log(`\n${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
