import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  newsCacheTable,
  researchRunsTable,
  type NewsProvider,
  type StoredNewsArticle,
  type StoredPost,
  type StoredMarketMetadata,
} from "@workspace/db";
import {
  GetResearchRunParams,
  GetResearchRunResponse,
  SearchAssetNewsBody,
  SearchAssetNewsResponse,
  StartResearchRunBody,
  StartResearchRunResponse,
} from "@workspace/api-zod";
import {
  apifyRequest,
  fetchMarketBars,
  buildAssetSearchTerms,
  buildWindowedSearchTerms,
} from "../lib/forecasting";

const NEWS_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_ACTOR = "apidojo~tweet-scraper";

type ApifyRun = {
  data?: {
    id?: string;
    status?: string;
    statusMessage?: string;
    defaultDatasetId?: string;
  };
};

function toPublicRun(row: typeof researchRunsTable.$inferSelect) {
  return {
    id: row.id,
    assetSymbol: row.assetSymbol,
    actorId: row.actorId,
    status: row.status,
    actorRunId: row.actorRunId ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    postCount: row.postCount,
    priceCount: row.priceCount,
    error: row.error,
  };
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

function dedupeArticles(articles: StoredNewsArticle[]): StoredNewsArticle[] {
  const byUrl = new Map<string, StoredNewsArticle>();
  for (const article of articles) {
    const key = article.url.toLowerCase().replace(/\/+$/, "");
    const existing = byUrl.get(key);
    if (existing) {
      existing.providers = [...new Set([...existing.providers, ...article.providers])];
    } else {
      byUrl.set(key, { ...article, providers: [...article.providers] });
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => {
      const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return bTime - aTime;
    })
    .slice(0, 10);
}

export function createResearchRouter(
  { database = db }: { database?: typeof db } = {},
): IRouter {
  const router: IRouter = Router();

router.post("/research/runs", async (req, res): Promise<void> => {
  const parsed = StartResearchRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const assetSymbol = parsed.data.assetSymbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^=_-]{1,20}$/.test(assetSymbol)) {
    res.status(400).json({ error: "Use a valid asset ticker, such as BTC-USD or AAPL." });
    return;
  }
  const actorId = parsed.data.actorId || DEFAULT_ACTOR;
  if (!/^[A-Za-z0-9_~-]{1,120}$/.test(actorId)) {
    res.status(400).json({ error: "The Apify actor ID contains unsupported characters." });
    return;
  }
  try {
    let companyName = parsed.data.companyName?.trim();
    let marketMetadata: StoredMarketMetadata | undefined;
    const priceBars = await fetchMarketBars(
      assetSymbol, parsed.data.lookbackDays ?? 180,
      (name) => { companyName ||= name; }, undefined, (market) => { marketMetadata = market; },
    );
    if (priceBars.length < 20) {
      res.status(400).json({ error: "The selected asset returned fewer than 20 daily bars." });
      return;
    }
    const [created] = await database
      .insert(researchRunsTable)
      .values({
        assetSymbol,
        marketMetadata,
        actorId,
        searchQuery: buildAssetSearchTerms(assetSymbol, parsed.data.searchQuery, companyName).join(" | "),
        costAssumptions: { transactionCostBps: 1, slippageBps: 3, marketImpactBps: 1, annualBorrowRateBps: 300, ...parsed.data.costAssumptions },
        lookbackDays: parsed.data.lookbackDays ?? 180,
        maxPosts: parsed.data.maxPosts ?? 1000,
        status: "queued",
        priceBars,
        priceCount: priceBars.length,
      })
      .returning();
    try {
      const start = new Date(
        Date.now() - (parsed.data.lookbackDays ?? 180) * 86_400_000,
      ).toISOString();
      const input = {
        searchTerms: buildWindowedSearchTerms(
          buildAssetSearchTerms(assetSymbol, parsed.data.searchQuery, companyName),
          new Date(start), new Date(),
        ),
        start,
        end: new Date().toISOString(),
        maxItems: parsed.data.maxPosts ?? 1000,
        sort: "Latest",
        tweetLanguage: "en",
        includeSearchTerms: true,
      };
      const actor = await apifyRequest<ApifyRun>(
        `/v2/actors/${encodeURIComponent(actorId)}/runs?waitForFinish=0`,
        { method: "POST", body: input },
      );
      if (!actor.data?.id) throw new Error("Apify did not return a run ID.");
      const [updated] = await database
        .update(researchRunsTable)
        .set({ actorRunId: actor.data.id, status: "scraping" })
        .where(and(eq(researchRunsTable.id, created.id), eq(researchRunsTable.status, "queued")))
        .returning();
      if (!updated) throw new Error("Collection setup expired before its Apify ID could be saved.");
      res.status(202).json(StartResearchRunResponse.parse(toPublicRun(updated)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the Apify actor.";
      const [failed] = await database
        .update(researchRunsTable)
        .set({ status: "failed", finishedAt: new Date(), error: message })
        .where(and(eq(researchRunsTable.id, created.id), eq(researchRunsTable.status, "queued")))
        .returning();
      res.status(502).json({ error: failed?.error || message });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not retrieve market prices.";
    req.log.error({ assetSymbol, error: message }, "Could not start research run");
    res.status(502).json({ error: message });
  }
});

router.get("/research/runs/:runId", async (req, res): Promise<void> => {
  const params = GetResearchRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const [run] = await database.select().from(researchRunsTable)
      .where(eq(researchRunsTable.id, params.data.runId)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Research run not found." });
      return;
    }
    res.json(GetResearchRunResponse.parse(toPublicRun(run)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the Apify run.";
    req.log.error({ runId: params.data.runId, error: message }, "Could not update run status");
    res.status(502).json({ error: message });
  }
});

router.post("/research/news", async (req, res): Promise<void> => {
  const parsed = SearchAssetNewsBody.safeParse(req.body);
  if (!parsed.success || !/^[A-Z0-9.^=_-]{1,20}$/.test(parsed.data.assetSymbol.trim().toUpperCase())) {
    res.status(400).json({ error: "Use a valid asset ticker and news query." });
    return;
  }
  try {
    const result = await searchAssetNews(database, parsed.data.assetSymbol.trim().toUpperCase(), parsed.data.companyName);
    res.status(Object.keys(result.providerErrors).length === 2 ? 502 : 200).json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "News search failed." });
  }
});
  return router;
}

export async function searchAssetNews(
  database: typeof db,
  assetSymbol: string,
  companyName?: string | null,
) {
    const [cached] = await database
      .select()
      .from(newsCacheTable)
      .where(eq(newsCacheTable.assetSymbol, assetSymbol))
      .limit(1);
    if (
      cached &&
      Date.now() - cached.fetchedAt.getTime() < NEWS_CACHE_MS &&
      cached.articles.every(
        (article) => Array.isArray(article.providers) && article.providers.length > 0,
      )
    ) {
      return { articles: cached.articles, providerErrors: {} };
    }

    const topic = companyName?.trim()
      ? `${assetSymbol} ${companyName.trim()}`
      : assetSymbol;
    const results = await Promise.allSettled([
      (async () => {
        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) throw new Error("TAVILY_API_KEY is not configured.");
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query: `${topic} latest market news`,
            topic: "news",
            search_depth: "basic",
            max_results: 6,
            time_range: "month",
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}.`);
        const body = (await response.json()) as {
          results?: Array<{
            title?: string;
            url?: string;
            published_date?: string;
            content?: string;
          }>;
        };
        return (body.results ?? []).flatMap((article) => {
          if (!article.title || !article.url) return [];
          return [{
            title: article.title.slice(0, 300),
            url: article.url,
            publishedAt: article.published_date ?? null,
            source: sourceHost(article.url),
            snippet: article.content?.slice(0, 1000) ?? null,
            providers: ["Tavily"] as NewsProvider[],
          }];
        });
      })(),
      (async () => {
        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) throw new Error("EXA_API_KEY is not configured. Standalone Exa access requires its own API key.");
        const options = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `${topic} latest market news`,
            type: "auto",
            numResults: 6,
            category: "news",
            contents: { text: { maxCharacters: 700 } },
          }),
        };
        const response = await fetch("https://api.exa.ai/search", {
              ...options, headers: { ...options.headers, "x-api-key": apiKey },
              signal: AbortSignal.timeout(20_000),
            });
        if (!response.ok) throw new Error(`Exa returned HTTP ${response.status}.`);
        const body = (await response.json()) as {
          results?: Array<{
            title?: string;
            url?: string;
            publishedDate?: string;
            text?: string;
          }>;
        };
        return (body.results ?? []).flatMap((article) => {
          if (!article.title || !article.url) return [];
          return [{
            title: article.title.slice(0, 300),
            url: article.url,
            publishedAt: article.publishedDate ?? null,
            source: sourceHost(article.url),
            snippet: article.text?.slice(0, 1000) ?? null,
            providers: ["Exa"] as NewsProvider[],
          }];
        });
      })(),
    ]);
    const providerNames = ["tavily", "exa"] as const;
    const providerErrors: Partial<Record<(typeof providerNames)[number], string>> = {};
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        providerErrors[providerNames[index]] =
          result.reason instanceof Error ? result.reason.message : "Provider failed.";
      }
    });
    const articles: StoredNewsArticle[] = dedupeArticles(
      results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    );
    if (Object.keys(providerErrors).length === 0) {
      await database
        .insert(newsCacheTable)
        .values({ assetSymbol, articles, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: newsCacheTable.assetSymbol,
          set: { articles, fetchedAt: new Date() },
        });
    }
    return SearchAssetNewsResponse.parse({
        articles,
        providerErrors,
      });
}

export default createResearchRouter();
