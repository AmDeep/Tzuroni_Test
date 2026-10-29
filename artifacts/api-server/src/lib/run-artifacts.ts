import {
  db, researchDailyFeaturesTable, researchRunNewsTable,
  type StoredDailyFeature,
} from "@workspace/db";
import type { ModelResult } from "./forecasting";

export async function persistDailyFeatures(
  database: typeof db, runId: string, assetSymbol: string, output: ModelResult,
) {
  const rows = output.alignedDailyData;
  // Older model fixtures/runs do not contain the new session-level export.
  if (!Array.isArray(rows) || !rows.length) return;
  const values = (rows as StoredDailyFeature[]).map((row) => ({
    runId, assetSymbol, sessionDate: row.sessionDate,
    barTimestamp: new Date(row.timestamp), close: row.close,
    sentimentScore: row.sentimentScore, postVolume: row.postVolume,
    engagement: row.engagement, return1d: row.return1d,
  }));
  for (let offset = 0; offset < values.length; offset += 500) {
    await database.insert(researchDailyFeaturesTable).values(values.slice(offset, offset + 500));
  }
}

export type NewsCollector = (database: typeof db, asset: string) => Promise<{
  articles: typeof researchRunNewsTable.$inferInsert.articles;
  providerErrors: Record<string, string | undefined>;
}>;

export async function persistNewsSnapshot(
  database: typeof db, runId: string, asset: string, collect: NewsCollector,
) {
  let snapshot;
  try {
    snapshot = await collect(database, asset);
  } catch (error) {
    const message = error instanceof Error ? error.message : "News collection failed.";
    snapshot = { articles: [], providerErrors: { tavily: message, exa: message } };
  }
  await database.insert(researchRunNewsTable).values({
    runId, articles: snapshot.articles,
    providerErrors: Object.fromEntries(Object.entries(snapshot.providerErrors).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    fetchedAt: new Date(),
  });
}
