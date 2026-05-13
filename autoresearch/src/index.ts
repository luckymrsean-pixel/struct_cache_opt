import { load } from "./config";
import { runLoop } from "./loop";
import { startWebServer } from "./web";
import { Terminal } from "./terminal";
import { InteractivePty } from "./interactive-pty";


const cfgPath = process.argv[2] ?? "autoresearch.yml";
const port    = Number(process.env.AR_PORT ?? 8080);
// AR_HEADLESS=1 skips the web server + interactive PTY and just runs the loop
// once for cfg.iterations iters, then exits. Used by meta-bench.sh.
const headless = process.env.AR_HEADLESS === "1";

process.on("SIGINT", () => {
  console.error("\n[autoresearch] SIGINT — exiting");
  process.exit(130);
});

const cfg = load(cfgPath);

(async () => {
  if (headless) {
    console.error(`[autoresearch] headless mode: ${cfg.iterations} iters → ${cfg.tsvPath}`);
    // runLoop with no term arg = legacy/test code path: it creates its own
    // PTY, runs one session, exits. This is exactly what we want for bench.
    await runLoop(cfg);
    return;
  }

  // Two PTYs:
  //   - cli      : interactive — dashboard CLI pane, for `claude login` etc.
  //   - loopTerm : automation  — runs ideate/apply/build/verify; its bytes
  //                are mirrored read-only to the dashboard's "main" pane.
  const cli      = new InteractivePty();
  const loopTerm = new Terminal();

  await cli.start();
  await loopTerm.start();

  startWebServer(cfg, cli, loopTerm, port);

  await runLoop(cfg, loopTerm);
})().catch((e: unknown) => {
  console.error("[autoresearch] fatal:", e);
  process.exit(1);
});
