import app from "./app";
import { logger } from "./lib/logger";
import { db, pool } from "@workspace/db";
import { createResearchWorkStore } from "./lib/research-work-store";
import { createResearchWorker } from "./lib/research-worker";
import { searchAssetNews } from "./routes/research";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const worker = createResearchWorker({
  store: createResearchWorkStore(),
  log: logger,
  collectNews: (asset) => searchAssetNews(db, asset),
});
const stopWorker = worker.start();
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.all([
      stopWorker(),
      new Promise<void>((resolve) => { server.close(() => resolve()); }),
    ]).then(() => pool.end()).then(() => process.exit(0)).catch((error) => {
      logger.error({ error }, "Shutdown failed; unfinished research will resume from its lease");
      process.exit(1);
    });
  });
}
