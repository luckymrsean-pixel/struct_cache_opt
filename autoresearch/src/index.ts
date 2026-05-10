import { load } from "./config";
import { runLoop } from "./loop";
import { startWebServer } from "./web";
import { Terminal } from "./terminal";
import { InteractivePty } from "./interactive-pty";


const cfgPath = process.argv[2] ?? "autoresearch.yml";
const port    = Number(process.env.AR_PORT ?? 8080);

process.on("SIGINT", () => {
  console.error("\n[autoresearch] SIGINT — exiting");
  process.exit(130);
});

const cfg = load(cfgPath);

(async () => {
  // Two PTYs:
  //   - cli      : interactive — dashboard CLI pane, for `claude login` etc.
  //   - loopTerm : automation  — runs ideate/apply/build/verify; its bytes
  //                are mirrored read-only to the dashboard's "main" pane so
  //                the operator sees Stage 1 LLM output live.
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
