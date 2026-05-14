/**
 * Unit tests for stage_log helpers — pure file I/O + ANSI stripping.
 * Run: tsx scripts/test-stage-log.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  stageLogPath,
  writeStageLogHead,
  writeStageLogTail,
  stripAnsi,
} from "../src/stage_log";

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

const workdir = mkdtempSync(join(tmpdir(), "ar-stage-log-"));

test("stageLogPath resolves under <workdir>/.ar", () => {
  eq("path", stageLogPath(workdir, 3), join(workdir, ".ar", "stage-3.log"));
});

test("stripAnsi removes CSI sequences", () => {
  eq("plain", stripAnsi("hello"), "hello");
  eq("color", stripAnsi("\x1b[32mok\x1b[0m"), "ok");
  eq("cursor", stripAnsi("\x1b[2K\x1b[1Adone"), "done");
});

test("stripAnsi normalizes CRLF and CR to LF", () => {
  eq("crlf", stripAnsi("a\r\nb"), "a\nb");
  eq("cr",   stripAnsi("a\rb"),   "a\nb");
});

test("writeStageLogHead creates .ar/ and truncates", async () => {
  await writeStageLogHead(workdir, 4, 7, "/bin/echo hi");
  const p = stageLogPath(workdir, 4);
  if (!existsSync(p)) throw new Error("file not created");
  const body = readFileSync(p, "utf8");
  if (!body.startsWith("# iter 7  stage 4  begin")) throw new Error(`head wrong: ${body.slice(0, 80)}`);
  if (!body.includes("# cmd: /bin/echo hi")) throw new Error("cmd line missing");

  // Re-call should truncate, not append
  await writeStageLogHead(workdir, 4, 8, "/bin/true");
  const after = readFileSync(p, "utf8");
  if (after.includes("iter 7")) throw new Error("did not truncate previous iter");
});

test("writeStageLogTail appends body + footer", async () => {
  await writeStageLogHead(workdir, 5, 1, "cmd-a");
  await writeStageLogTail(workdir, 5, {
    stdout: "line one\n",
    stderr: "warn\x1b[31m err\x1b[0m\n",
    exitCode: 0,
    durationMs: 1234,
  });
  const body = readFileSync(stageLogPath(workdir, 5), "utf8");
  if (!body.includes("line one\n")) throw new Error("stdout missing");
  if (!body.includes("warn err\n")) throw new Error(`stderr not ansi-stripped: ${body}`);
  if (!body.match(/# exit=0  duration=1234ms  end/)) throw new Error(`footer missing: ${body}`);
});

rmSync(workdir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
