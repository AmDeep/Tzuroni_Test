/** Administrative full-population rebuild; never edits completed evaluations. */
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { db, pool, historicalCorporaTable, type HistoricalCorpusManifest } from "@workspace/db";
import { eq } from "drizzle-orm";
import { corpusStorage } from "../lib/corpus-storage";

const root = path.resolve(import.meta.dirname, "../../../..");
const folder = path.join(root, "generated-artifacts", "corpus-rebuild");
try {
  const [row] = await db.select().from(historicalCorporaTable)
    .where(eq(historicalCorporaTable.id, "top-companies-2015-2019")).limit(1);
  if (!row) throw new Error("Install the licensed source corpus first.");
  await mkdir(folder, { recursive: true });
  const archive = path.join(folder, "source.zip");
  const manifestFile = path.join(folder, "manifest.json");
  const location = row.archiveObject.replace(/^gs:\/\//, "").replace(/^\/+/, "");
  const slash = location.indexOf("/");
  if (slash < 0) throw new Error("Expected a bucket/object archive reference.");
  await corpusStorage.bucket(location.slice(0, slash)).file(location.slice(slash + 1))
    .download({ destination: archive });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python", [
      path.join(root, "artifacts/crowdwisdom-forecast/python/prepare_top_company_corpus.py"),
      "--archive", archive, "--output", manifestFile,
    ], { stdio: "inherit", cwd: root });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Corpus preparation exited ${code}`)));
  });
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as HistoricalCorpusManifest;
  if (manifest.sha256 !== row.manifest.sha256 || manifest.uniqueUsablePosts !== row.manifest.uniqueUsablePosts) {
    throw new Error("Source hash or population changed; original manifest retained.");
  }
  await db.update(historicalCorporaTable).set({ manifest }).where(eq(historicalCorporaTable.id, row.id));
  console.log("Installed text-only corpus features; completed evaluations preserved.", manifest.uniqueUsablePosts);
} finally {
  await pool.end();
}
