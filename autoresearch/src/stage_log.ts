import { mkdir, writeFile, appendFile } from "fs/promises";
import { join, dirname } from "path";

export function stageLogPath(workdir: string, stage: number): string {
  return join(workdir, ".ar", `stage-${stage}.log`);
}

/**
 * Strip ANSI CSI escape sequences and normalize CR/CRLF to LF.
 * Used to keep .ar/stage-N.log files plain-text so the browser's <pre>
 * renderer doesn't need a terminal emulator.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
}

export async function writeStageLogHead(
  workdir: string,
  stage:   number,
  iter:    number,
  cmd:     string,
): Promise<void> {
  const path = stageLogPath(workdir, stage);
  await mkdir(dirname(path), { recursive: true });
  const oneLine = cmd.replace(/\n/g, " ⏎ ").slice(0, 300);
  const head =
    `# iter ${iter}  stage ${stage}  begin  ${new Date().toISOString()}\n` +
    `# cmd: ${oneLine}\n`;
  await writeFile(path, head, "utf8");
}

interface StageResult {
  stdout:     string;
  stderr:     string;
  exitCode:   number;
  durationMs: number;
}

export async function writeStageLogTail(
  workdir: string,
  stage:   number,
  r:       StageResult,
): Promise<void> {
  const path = stageLogPath(workdir, stage);
  const body = stripAnsi(r.stdout) + stripAnsi(r.stderr);
  const tail =
    `# exit=${r.exitCode}  duration=${r.durationMs}ms  end  ${new Date().toISOString()}\n`;
  await appendFile(path, body + tail, "utf8");
}
