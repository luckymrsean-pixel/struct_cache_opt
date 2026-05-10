/**
 * InteractivePty unit tests.
 *
 * Mirrors test-term.ts pattern: bare TS run via tsx, manual asserts.
 */

import { InteractivePty } from "../src/interactive-pty";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("\n=== interactive-pty.ts tests ===\n");

  // ── Test 1: spawn → alive=true, pid set ───────────────────────────────────
  await test("start() → alive=true, pid is positive integer", async () => {
    const p = new InteractivePty();
    await p.start();
    eq("alive", p.alive, true);
    if (typeof p.pid !== "number" || p.pid <= 0) {
      throw new Error(`pid = ${p.pid}, want positive number`);
    }
    p.dispose();
  });

  // ── Test 2: data event fires when writing ─────────────────────────────────
  await test("write('echo HI\\n') triggers data event containing 'HI'", async () => {
    const p = new InteractivePty();
    await p.start();
    let buf = "";
    p.on("data", (d: string) => { buf += d; });
    p.write("echo HI\n");
    // Wait up to 2s for echo to round-trip
    for (let i = 0; i < 40 && !buf.includes("HI"); i++) await sleep(50);
    if (!buf.includes("HI")) {
      throw new Error(`echo never came back. buf=${JSON.stringify(buf)}`);
    }
    p.dispose();
  });

  // ── Test 3: dispose() → alive=false + 'dead' event ────────────────────────
  await test("dispose() → alive=false and 'dead' event fires", async () => {
    const p = new InteractivePty();
    await p.start();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("dead never fired (5s)")), 5000);
      p.once("dead", () => { clearTimeout(t); resolve(); });
      p.dispose();
    });
    eq("alive after dispose", p.alive, false);
  });

  // ── Test 4: getChildren() empty when idle ─────────────────────────────────
  await test("getChildren() returns [] when bash is idle", async () => {
    const p = new InteractivePty();
    await p.start();
    await sleep(200); // let bash settle
    const kids = await p.getChildren();
    p.dispose();
    if (kids.length !== 0) {
      throw new Error(`expected [], got ${JSON.stringify(kids)}`);
    }
  });

  // ── Test 5: getChildren() lists running child ─────────────────────────────
  await test("getChildren() lists 'sleep' while sleep is running", async () => {
    const p = new InteractivePty();
    await p.start();
    p.write("sleep 30 &\n");
    await sleep(300); // give bash time to fork
    const kids = await p.getChildren();
    p.dispose();
    if (!kids.some((k) => k.cmd.includes("sleep"))) {
      throw new Error(`expected sleep child, got ${JSON.stringify(kids)}`);
    }
  });

  // ── Test 6: restart() emits 'restarted' and assigns new pid ───────────────
  await test("restart() kills, respawns, emits 'restarted', new pid differs", async () => {
    const p = new InteractivePty();
    await p.start();
    const oldPid = p.pid;
    const restarted = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("restarted never fired (10s)")), 10000);
      p.once("restarted", () => { clearTimeout(t); resolve(); });
    });
    await p.restart();
    await restarted;
    if (!p.alive) throw new Error("alive=false after restart");
    if (p.pid === oldPid) throw new Error(`pid did not change: ${p.pid}`);
    p.dispose();
  });

  // ── Test 7: restart() kills lingering child processes ─────────────────────
  await test("restart() kills child processes (sleep)", async () => {
    const p = new InteractivePty();
    await p.start();
    p.write("sleep 60 &\n");
    await sleep(300);
    const before = await p.getChildren();
    if (!before.some((k) => k.cmd.includes("sleep"))) {
      throw new Error("sleep didn't start");
    }
    await p.restart();
    await sleep(200);
    const after = await p.getChildren();
    if (after.length !== 0) {
      throw new Error(`children survived restart: ${JSON.stringify(after)}`);
    }
    p.dispose();
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error("[test-interactive-pty] fatal:", e);
  process.exit(1);
});
