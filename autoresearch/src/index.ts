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
  // Three PTYs: main + cli are interactive (dashboard owns them); loopTerm
  // runs the loop's automation in isolation so user keystrokes never
  // collide with marker parsing.
  const main     = new InteractivePty();
  const cli      = new InteractivePty();
  const loopTerm = new Terminal();

  await main.start();
  await cli.start();
  await loopTerm.start();

  startWebServer(cfg, main, cli, port);

  await runLoop(cfg, loopTerm);
})().catch((e: unknown) => {
  console.error("[autoresearch] fatal:", e);
  process.exit(1);
});
