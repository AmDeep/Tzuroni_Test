import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { db, historicalCorporaTable, type HistoricalCorpusManifest } from "@workspace/db";
import { corpusStorage } from "../lib/corpus-storage";

async function main() {
  const [archive, manifestPath] = process.argv.slice(2);
  if (!archive || !manifestPath) throw new Error("Usage: register-corpus <archive.zip> <manifest.json>");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as HistoricalCorpusManifest;
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  if (digest.digest("hex") !== manifest.sha256) throw new Error("Source archive checksum differs from prepared features.");
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucket) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID must name your private archive bucket.");
  const objectName = `historical-corpora/${manifest.id}/${manifest.sha256}.zip`;
  await corpusStorage.bucket(bucket).upload(archive, {
    destination: objectName,
    metadata: { contentType: "application/zip", metadata: { license: manifest.license, sourceUrl: manifest.sourceUrl, sha256: manifest.sha256 } },
    validation: "crc32c",
  });
  const archiveObject = `gs://${bucket}/${objectName}`;
  await db.insert(historicalCorporaTable).values({ id: manifest.id, manifest, archiveObject })
    .onConflictDoUpdate({ target: historicalCorporaTable.id, set: { manifest, archiveObject, importedAt: new Date() } });
  console.log(JSON.stringify({ id: manifest.id, license: manifest.license, sourceRows: manifest.sourceRows, usablePosts: manifest.uniqueUsablePosts, assets: Object.keys(manifest.assets), archivePreserved: true }));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
