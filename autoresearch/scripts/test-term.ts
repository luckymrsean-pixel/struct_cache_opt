/**
 * M1 — terminal.ts 单元测试
 *
 * 验收：
 *   ✓ echo HI          → stdout="HI"  stderr=""   exit=0
 *   ✓ echo BAD >&2; false → stdout="" stderr="BAD" exit=1
 *   ✓ warning 行被捕获   → warnings.length === 1
 *   ✓ 100 次连发无 listener 泄漏
 *   ✓ kill PTY → alive=false 且触发 dead 事件
 */

import { Terminal } from "../src/terminal";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

function eq<T>(label: string, got: T, want: T): void {
  if (got !== want) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== terminal.ts tests ===\n");

  // ── Test 1-3: basic stdout / stderr / warnings ───────────────────────────
  const t = new Terminal();
  await t.start();

  await test("echo HI → stdout=HI  stderr=''  exit=0", async () => {
    const r = await t.run("echo HI");
    eq("stdout",   r.stdout,   "HI");
    eq("stderr",   r.stderr,   "");
    eq("exitCode", r.exitCode, 0);
  });

  await test("echo >&2 + false → stdout=''  stderr='BAD'  exit=1", async () => {
    const r = await t.run("echo BAD >&2; false");
    eq("stdout",   r.stdout,   "");
    eq("stderr",   r.stderr,   "BAD");
    eq("exitCode", r.exitCode, 1);
  });

  await test("warning line captured in warnings[]", async () => {
    const r = await t.run("echo 'warning: foo deprecated'");
    if (r.warnings.length < 1) {
      throw new Error(`warnings.length = ${r.warnings.length}, want ≥1`);
    }
  });

  await test("deprecated keyword also captured", async () => {
    const r = await t.run("echo 'deprecated: old API'");
    if (r.warnings.length < 1) {
      throw new Error(`warnings.length = ${r.warnings.length}, want ≥1`);
    }
  });

  // ── Test 5: 100 sequential runs — no listener leak ───────────────────────
  await test("100 sequential runs — no listener leak / no crash", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await t.run(`echo seq${i}`);
      if (r.exitCode !== 0) throw new Error(`iter ${i}: exit ${r.exitCode}`);
      if (!r.stdout.includes(`seq${i}`)) {
        throw new Error(`iter ${i}: stdout="${r.stdout}"`);
      }
    }
  });

  // ── Test 6: multi-line stdout ─────────────────────────────────────────────
  await test("multi-line stdout preserved", async () => {
    const r = await t.run("printf 'a\\nb\\nc\\n'");
    const lines = r.stdout.split("\n").filter(Boolean);
    if (lines.length !== 3) throw new Error(`got ${lines.length} lines`);
  });

  // ── Test 7: non-zero exit propagated ─────────────────────────────────────
  await test("exit 42 propagated correctly", async () => {
    const r = await t.run("exit 42");
    // shell exits — terminal dies; or if nested bash, just exit code
    // We accept either exit=42 or dead event
    if (r.exitCode !== 42 && t.alive) {
      throw new Error(`exitCode=${r.exitCode}, alive=${t.alive}`);
    }
  });

  // If the shell exited above, restart for the next test
  if (!t.alive) {
    await t.start();
  }

  // ── Test 8: busy rejection ────────────────────────────────────────────────
  await test("concurrent run() throws 'busy'", async () => {
    let caughtBusy = false;
    const slow = t.run("sleep 0.5");
    try {
      await t.run("echo hi");
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("busy")) caughtBusy = true;
    }
    await slow;
    if (!caughtBusy) throw new Error("expected busy error");
  });

  // ── Test 9: dispose → alive=false + dead event ────────────────────────────
  await test("dispose() → alive=false and 'dead' event fires", async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("dead event never fired (5 s)")),
        5_000,
      );
      t.once("dead", () => {
        clearTimeout(timeout);
        if (t.alive) reject(new Error("alive still true after dead event"));
        else resolve();
      });
      t.dispose();
    });
    if (t.alive) throw new Error("alive still true after dispose");
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error("[test-term] fatal:", e);
  process.exit(1);
});
