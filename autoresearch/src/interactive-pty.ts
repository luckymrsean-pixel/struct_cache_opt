import * as pty from "node-pty";
import { EventEmitter } from "events";
import { exec, type ExecException } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * InteractivePty — plain interactive bash PTY for the dashboard.
 *
 * No marker wrapping, no run() method. Just relays bytes both directions.
 * Used by main/cli terminals; the loop's automation uses Terminal instead.
 */
export class InteractivePty extends EventEmitter {
  alive = false;
  pid: number | null = null;

  private proc: pty.IPty | null = null;

  async start(): Promise<void> {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }

    this.proc = pty.spawn("bash", ["--noprofile", "--norc"], {
      name: "xterm-256color",
      cols: 220,
      rows: 50,
      env:  { ...process.env, TERM: "xterm-256color", PS1: "$ " },
    });

    this.alive = true;
    this.pid   = this.proc.pid;

    this.proc.onData((d: string) => {
      this.emit("data", d);
    });

    this.proc.onExit((e: { exitCode: number; signal?: number }) => {
      this.alive = false;
      const pid = this.pid;
      this.pid = null;
      this.emit("dead", { code: e.exitCode, signal: e.signal ?? null, pid });
    });
  }

  write(data: string): void {
    if (!this.alive || !this.proc) return;
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.alive || !this.proc) return;
    try { this.proc.resize(cols, rows); } catch { /* ignore */ }
  }

  /**
   * SIGTERM → 100ms grace → SIGKILL → wait for onExit → re-spawn.
   * Emits "restarted" on success, "restart-failed" with reason on failure.
   *
   * Concurrent calls are serialized — a second call while one is in-flight
   * returns the same Promise and does not spawn a duplicate PTY.
   */
  private _restartPromise: Promise<void> | null = null;

  async restart(): Promise<void> {
    if (this._restartPromise) return this._restartPromise;
    this._restartPromise = this._doRestart()
      .finally(() => { this._restartPromise = null; });
    return this._restartPromise;
  }

  private async _doRestart(): Promise<void> {
    if (this.proc) {
      const proc = this.proc;
      const exited = new Promise<void>((resolve) => {
        proc.onExit(() => resolve());
      });
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      const winner = await Promise.race([
        exited.then(() => "exit" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
      ]);
      if (winner === "timeout") {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        await exited;
      }
    }

    try {
      await this.start();
      this.emit("restarted");
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      this.emit("restart-failed", { reason });
    }
  }

  /**
   * List child processes spawned beneath this PTY's bash, e.g. a running
   * `copilot` or `sleep` command. Returns [] when bash is idle.
   *
   * Strategy:
   *   1. Try `pgrep -P <pid> -a` (returns "PID command-line" lines).
   *   2. Fallback: read /proc/<pid>/task/* /children + ps -o comm= for each.
   */
  async getChildren(): Promise<{ pid: number; cmd: string }[]> {
    if (!this.alive || this.pid == null) return [];
    const parent = this.pid;

    const pgrep = await this._exec(`pgrep -P ${parent} -a`);
    if (pgrep.code === 0 && pgrep.stdout.trim()) {
      return pgrep.stdout.trim().split("\n").map((line) => {
        const sp = line.indexOf(" ");
        const pid = Number(sp < 0 ? line : line.slice(0, sp));
        const cmd = sp < 0 ? "" : line.slice(sp + 1);
        return { pid, cmd };
      });
    }

    // pgrep available but no children → fast path, skip /proc scan.
    if (pgrep.code === 1 && !pgrep.stdout.trim()) return [];

    // Fallback: /proc/<pid>/task/*/children
    const taskDir = `/proc/${parent}/task`;
    if (!fs.existsSync(taskDir)) return [];
    const childPids = new Set<number>();
    for (const tid of fs.readdirSync(taskDir)) {
      const file = path.join(taskDir, tid, "children");
      try {
        for (const s of fs.readFileSync(file, "utf8").trim().split(/\s+/)) {
          if (s) childPids.add(Number(s));
        }
      } catch { /* ignore */ }
    }
    const out: { pid: number; cmd: string }[] = [];
    for (const cpid of childPids) {
      const ps = await this._exec(`ps -o comm= -p ${cpid}`);
      out.push({ pid: cpid, cmd: ps.stdout.trim() });
    }
    return out;
  }

  private _exec(cmd: string): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve) => {
      exec(cmd, { encoding: "utf8" }, (err: ExecException | null, stdout: string) => {
        resolve({ code: err?.code ?? 0, stdout: stdout ?? "" });
      });
    });
  }

  dispose(): void {
    this.alive = false;
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }
}
