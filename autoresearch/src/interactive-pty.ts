import * as pty from "node-pty";
import { EventEmitter } from "events";

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

  dispose(): void {
    this.alive = false;
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }
}
