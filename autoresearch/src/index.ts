import { load } from "./config";
import { runLoop } from "./loop";
import { startWebServer } from "./web";
import { Terminal } from "./terminal";

const cfgPath = process.argv[2] ?? "autoresearch.yml";
const port    = Number(process.env.AR_PORT ?? 8080);

process.on("SIGINT", () => {
  console.error("\n[autoresearch] SIGINT — exiting");
  process.exit(130);
});

const cfg = load(cfgPath);

(async () => {
  // One PTY shared by the dashboard and the loop. The dashboard's main
  // terminal pane forwards keystrokes to it, so the operator can do their
  // manual auth (e.g. `claude login`) before clicking Start. After Start,
  // the loop runs setupCmds + iterations on the same PTY.
  const term = new Terminal();
  await term.start();

  startWebServer(cfg, term, port);

  await runLoop(cfg, term);
})().catch((e: unknown) => {
  console.error("[autoresearch] fatal:", e);
  process.exit(1);
});
