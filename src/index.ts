import { config } from "./config.ts";
import { startServer } from "./server.ts";
import { startSlack } from "./slack.ts";
import { startWorker } from "./worker.ts";

async function main() {
  console.log("=== Rex platform booting ===");
  console.log(`[config] auth=${config.authMode} model=${config.model} workspace=${config.workspace} slack=${config.slack.enabled}`);

  startServer();
  startWorker();
  await startSlack();

  console.log("=== Rex is live ===");
}

main().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
