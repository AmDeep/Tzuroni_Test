import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const artifactDirectory = path.resolve(testDirectory, "..");
const outputDirectory = await mkdtemp(
  path.join(os.tmpdir(), "forecast-api-test-"),
);
const testNames = ["forecast-api", "research-worker", "market-calendars", "news-providers"];
const outputFiles = testNames.map((name) => path.join(outputDirectory, `${name}.test.cjs`));

try {
  await build({
    entryPoints: testNames.map((name) => path.join(testDirectory, `${name}.test.ts`)),
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: outputDirectory,
    outExtension: { ".js": ".cjs" },
    nodePaths: [path.resolve(artifactDirectory, "../../node_modules")],
  });

  const result = spawnSync(process.execPath, ["--test", ...outputFiles], {
    cwd: artifactDirectory,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: process.env.RUN_WORKER_DB_TESTS === "1" ? process.env.DATABASE_URL :
        "postgresql://forecast-test:forecast-test@127.0.0.1:1/forecast-test",
    },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
