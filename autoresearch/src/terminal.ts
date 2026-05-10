import * as pty from "node-pty";
import { EventEmitter } from "events";

// ─── Public types ────────────────────────────────────────────────────────────

export interface CmdResult {
  cmd:        string;
  exitCode:   number;
  stdout:     string;   // only __OUT__ lines, stripped of prefix
  stderr:     string;   // only __ERR__ lines, stripped of prefix
  warnings:   string[]; // lines matching /\b(warning|warn|deprecated)\b/i
  durationMs: number;
}

// ─── Terminal ────────────────────────────────────────────────────────────────

export class Terminal extends EventEmitter {
  alive = false;

  private proc:  pty.IPty | null = null;
  private buf  = "";
  private busy = false;

  // ── start ──────────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    // Kill any previous process before spawning a new one
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }

    this.buf   = "";
    this.busy  = false;
    this.alive = false;

    this.proc = pty.spawn("bash", ["--noprofile", "--norc"], {
      name: "xterm-256color",
      cols: 220,
      rows: 50,
      env:  { ...process.env, TERM: "dumb" },
    });

    this.alive = true;

    // ── INVARIANT: onData attached ONCE here, never again ───────────────────
    this.proc.onData((d: string) => {
      this.buf += d;
      process.stderr.write(d);           // real-time mirror to stderr
      this.emit("data", d);              // forward raw PTY bytes to web UI
    });

    this.proc.onExit(() => {
      this.alive = false;
      this.emit("dead");
    });

    // Sentinel: wait for shell ready BEFORE sending setup commands
    await this._sentinel();

    // Suppress echo + blank prompt so output stays clean
    this.proc.write("stty -echo; export PS1=''; export PS2=''\n");
    await this._sleep(150);
    this.buf = "";                        // discard all startup noise
  }

  // ── run ────────────────────────────────────────────────────────────────────
  async run(cmd: string, timeoutMs = 5 * 60_000): Promise<CmdResult> {
    if (this.busy)  throw new Error("Terminal is busy — re-entry not allowed");
    if (!this.alive) throw new Error("Terminal is dead");

    this.busy = true;
    this.buf  = "";

    const marker   = `MK_${Date.now()}_${rand()}`;
    const startMs  = Date.now();

    // ── INVARIANT: wrapper script captures exit code then waits for sed ──────
    //   $? captured before `wait` to survive background sed processes.
    const wrapped =
      `{ ${cmd}; } ` +
      `1> >(sed -u 's/^/__OUT__/') ` +
      `2> >(sed -u 's/^/__ERR__/' >&2); ` +
      `_AR_EC=$?; wait; ` +
      `printf '__EXIT__%d__END__${marker}\\n' "$_AR_EC"\n`;

    this.proc!.write(wrapped);

    try {
      const raw        = await this._readUntilMarker(marker, timeoutMs);
      const durationMs = Date.now() - startMs;
      return this._parse(cmd, raw, marker, durationMs);
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.alive = false;
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }

  // ── private helpers ────────────────────────────────────────────────────────

  /** Send a unique echo and wait for it to appear — confirms shell is ready. */
  private async _sentinel(): Promise<void> {
    const tag = `READY_${Date.now()}_${rand()}`;
    this.proc!.write(`echo ${tag}\n`);
    await this._waitFor(tag, 10_000);
  }

  private _waitFor(str: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`Timeout waiting for sentinel: ${str}`)),
        timeoutMs,
      );
      const poll = setInterval(() => {
        if (this.buf.includes(str)) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 30);
    });
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Poll buf until the exit-marker line appears. */
  private _readUntilMarker(marker: string, timeoutMs: number): Promise<string> {
    // ── INVARIANT: regex matches only a standalone marker line, NOT the echo
    //   of the command itself (which appears before __OUT__/__ERR__ lines).
    const exitRe = new RegExp(
      `(^|\\n)__EXIT__\\d+__END__${marker}(\\r?\\n|$)`,
    );

    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error("Terminal dead")); return; }

      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error(`run() timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onDead = () => { cleanup(); reject(new Error("Terminal died during run()")); };
      this.once("dead", onDead);

      const poll = setInterval(() => {
        if (exitRe.test(this.buf)) {
          cleanup();
          resolve(this.buf);
        }
      }, 30);

      function cleanup() {
        clearInterval(poll);
        clearTimeout(deadline);
      }
    });
  }

  /** Split raw PTY output into stdout / stderr / warnings / exitCode. */
  private _parse(
    cmd: string,
    raw: string,
    marker: string,
    durationMs: number,
  ): CmdResult {
    const stdoutLines:  string[] = [];
    const stderrLines:  string[] = [];
    const warnLines:    string[] = [];
    let   exitCode              = 0;

    const exitRe = new RegExp(`__EXIT__(\\d+)__END__${marker}`);

    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("__OUT__")) {
        const l = line.slice(7);
        stdoutLines.push(l);
        if (/\b(warning|warn|deprecated)\b/i.test(l)) warnLines.push(l);
      } else if (line.startsWith("__ERR__")) {
        const l = line.slice(7);
        stderrLines.push(l);
        if (/\b(warning|warn|deprecated)\b/i.test(l)) warnLines.push(l);
      } else {
        const m = line.match(exitRe);
        if (m) exitCode = parseInt(m[1], 10);
      }
    }

    return {
      cmd,
      exitCode,
      stdout:     stdoutLines.join("\n").trim(),
      stderr:     stderrLines.join("\n").trim(),
      warnings:   warnLines,
      durationMs,
    };
  }
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}
