import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, historicalCorporaTable, researchRunsTable } from "@workspace/db";
import { GetHistoricalCorpusResponse, ImportHistoricalCorpusBody, ImportHistoricalCorpusResponse } from "@workspace/api-zod";
import { fetchMarketBars, runForecastModel, resolveExchangeMetadata } from "../lib/forecasting";
import { persistDailyFeatures, persistNewsSnapshot, type NewsCollector } from "../lib/run-artifacts";
import { searchAssetNews } from "./research";

export const CORPUS_ID = "top-companies-2015-2019";

export function createHistoricalCorpusRouter({
  database = db, forecastModel = runForecastModel, fetchPrices = fetchMarketBars, collectNews = searchAssetNews,
}: { database?: typeof db; forecastModel?: typeof runForecastModel; fetchPrices?: typeof fetchMarketBars; collectNews?: NewsCollector } = {}) {
  const router = Router();
  router.get("/forecast/corpus", async (_req, res) => {
    const [installed] = await database.select().from(historicalCorporaTable).where(eq(historicalCorporaTable.id, CORPUS_ID)).limit(1);
    if (!installed) { res.json({ available: false, assets: [] }); return; }
    const manifest = installed.manifest;
    res.json(GetHistoricalCorpusResponse.parse({
      ...manifest, available: true,
      assets: Object.entries(manifest.assets).map(([assetSymbol, asset]) => ({ assetSymbol, postCount: asset.postCount, sessionCount: asset.daily.length })),
    }));
  });
  router.post("/forecast/corpus/import", async (req, res) => {
    const parsed = ImportHistoricalCorpusBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const [installed] = await database.select().from(historicalCorporaTable).where(eq(historicalCorporaTable.id, CORPUS_ID)).limit(1);
    if (!installed) { res.status(404).json({ error: "The historical corpus has not been installed." }); return; }
    const { assetSymbol } = parsed.data;
    const manifest = installed.manifest;
    const asset = manifest.assets[assetSymbol];
    if (!manifest.method.startsWith("Unweighted VADER")) {
      res.status(422).json({ error: "Rebuild the corpus with point-in-time text-only sentiment before training a new RL evaluation. Older completed runs remain available." }); return;
    }
    if (!asset?.daily.length) { res.status(404).json({ error: "This company has no usable corpus posts." }); return; }
    const start = `${asset.daily[0].sessionDate}T00:00:00Z`;
    const end = new Date(Date.parse(`${asset.daily.at(-1)!.sessionDate}T00:00:00Z`) + 86400000).toISOString();
    let priceBars;
    let marketMetadata = resolveExchangeMetadata(assetSymbol);
    try {
      priceBars = await fetchPrices(assetSymbol, 180, undefined, { start, end }, (market) => { marketMetadata = market; });
      if (marketMetadata.calendar !== "XNYS") throw new Error("This corpus was aggregated on XNYS sessions; a different exchange would require reaggregation.");
      if (priceBars.length < 20) throw new Error("Fewer than 20 matching historical price bars were returned.");
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : "Historical prices unavailable." }); return;
    }
    const costs = { transactionCostBps: 1, slippageBps: 3, marketImpactBps: 1, annualBorrowRateBps: 300, ...parsed.data.costAssumptions };
    const [created] = await database.insert(researchRunsTable).values({
      assetSymbol, actorId: "historical-kaggle-corpus", searchQuery: `${manifest.title} (${manifest.license}; full corpus, no sampling)`,
      lookbackDays: Math.ceil((Date.parse(end) - Date.parse(start)) / 86400000),
      maxPosts: asset.postCount, status: "training", rawPosts: [], priceBars,
      postCount: asset.postCount, priceCount: priceBars.length, costAssumptions: costs, marketMetadata,
    }).returning();
    try {
      const output = await forecastModel({ assetSymbol, posts: [], priceBars, dailySentiment: asset.daily, costAssumptions: costs, marketMetadata });
      Object.assign(output, {
        historicalAsOf: asset.daily.at(-1)!.sessionDate,
        sourceTitle: manifest.title, sourceUrl: manifest.sourceUrl, sourceLicense: manifest.license,
        provenance: { corpusId: manifest.id, sourceUrl: manifest.sourceUrl, license: manifest.license, sourceArchiveSha256: manifest.sha256, sourceRows: manifest.sourceRows, uniqueUsableSourcePosts: manifest.uniqueUsablePosts, assetPosts: asset.postCount, duplicatesRemoved: manifest.duplicatesRemoved, invalidRowsRemoved: manifest.invalidRowsRemoved, sampling: manifest.sampling, method: manifest.method, limitations: manifest.limitations, prices: "Yahoo Finance historical daily closes (split-adjusted by provider)", preparedAt: manifest.preparedAt },
      });
      output.summary = `Historical backtest as of ${asset.daily.at(-1)!.sessionDate}, NOT a current trading signal. ${output.summary} Corpus limitations: ${manifest.limitations.join(" ")}`;
      await persistDailyFeatures(database, created.id, assetSymbol, output);
      await persistNewsSnapshot(database, created.id, assetSymbol, collectNews);
      const [completed] = await database.update(researchRunsTable).set({ modelOutput: output, status: "completed", finishedAt: new Date() }).where(eq(researchRunsTable.id, created.id)).returning();
      res.status(201).json(ImportHistoricalCorpusResponse.parse({ ...completed, actorRunId: completed.actorRunId ?? null }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Historical corpus training failed.";
      await database.update(researchRunsTable).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(researchRunsTable.id, created.id));
      req.log.error({ runId: created.id, error: message }, "Corpus backtest failed");
      res.status(422).json({ error: message });
    }
  });
  return router;
}

export default createHistoricalCorpusRouter();
