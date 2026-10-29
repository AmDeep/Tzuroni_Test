import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  db,
  researchRunsTable,
  researchRunNewsTable,
  type StoredPost,
  type StoredPriceBar,
} from "@workspace/db";
import {
  GetEvaluationReportQueryParams,
  GetEvaluationReportResponse,
  GetForecastDashboardQueryParams,
  GetForecastDashboardResponse,
  GetForecastHistoryQueryParams,
  GetForecastHistoryResponse,
  ImportHistoricalDataBody,
  ImportHistoricalDataResponse,
} from "@workspace/api-zod";
import { runForecastModel, resolveExchangeMetadata } from "../lib/forecasting";
import { calculateSentimentCoverage } from "../lib/sentiment-coverage";
import { searchAssetNews } from "./research";
import { persistDailyFeatures, persistNewsSnapshot, type NewsCollector } from "../lib/run-artifacts";

type ForecastRouteDependencies = {
  database: typeof db;
  forecastModel: typeof runForecastModel;
  collectNews?: NewsCollector;
};

export function createForecastRouter(
  { database, forecastModel, collectNews = searchAssetNews }: ForecastRouteDependencies = {
    database: db,
    forecastModel: runForecastModel,
  },
): IRouter {
  const router: IRouter = Router();

  router.get("/forecast/dashboard", async (req, res): Promise<void> => {
    const query = GetForecastDashboardQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const assetSymbol = query.data.asset.trim().toUpperCase();
    if (!/^[A-Z0-9.^=_-]{1,20}$/.test(assetSymbol)) {
      res.status(400).json({ error: "Use a valid asset ticker." });
      return;
    }
    const completedRunFilter = query.data.runId
      ? and(
          eq(researchRunsTable.assetSymbol, assetSymbol),
          eq(researchRunsTable.id, query.data.runId),
          eq(researchRunsTable.status, "completed"),
          isNotNull(researchRunsTable.modelOutput),
        )
      : and(
          eq(researchRunsTable.assetSymbol, assetSymbol),
          eq(researchRunsTable.status, "completed"),
          isNotNull(researchRunsTable.modelOutput),
        );
    const [[run], [failedRun]] = await Promise.all([
      database
        .select()
        .from(researchRunsTable)
        .where(completedRunFilter)
        .orderBy(desc(researchRunsTable.startedAt))
        .limit(1),
      database
        .select()
        .from(researchRunsTable)
        .where(
          and(
            eq(researchRunsTable.assetSymbol, assetSymbol),
            eq(researchRunsTable.status, "failed"),
          ),
        )
        .orderBy(desc(researchRunsTable.startedAt))
        .limit(1),
    ]);
    if (query.data.runId && !run) {
      res.status(404).json({
        error: "Selected completed forecast was not found for this asset.",
      });
      return;
    }
    const latestFailedRun = failedRun
      ? {
          id: failedRun.id,
          status: "failed" as const,
          error: failedRun.error,
          startedAt: failedRun.startedAt.toISOString(),
          finishedAt: failedRun.finishedAt?.toISOString() ?? null,
        }
      : null;

    if (!run?.modelOutput || run.status !== "completed") {
      res.json(
        GetForecastDashboardResponse.parse({
          assetSymbol,
          status: "empty",
          hasData: false,
          lastUpdated: null,
          currentPrice: null,
          sentimentScore: null,
          sentimentLabel: null,
          postCount: 0,
          priceCount: 0,
          series: [],
          forecast: [],
          metrics: [],
          sentimentCoverage: {
            postStartDate: null,
            postEndDate: null,
            activePostDays: 0,
            activePriceDays: 0,
            priceWindowDays: 0,
            coverageRatio: 0,
            isSparse: false,
          },
          latestFailedRun,
          summary:
            "No completed research run is available for this asset. Start an Apify run or import aligned historical posts and prices.",
        }),
      );
      return;
    }
    const [newsSnapshot] = await database.select().from(researchRunNewsTable)
      .where(eq(researchRunNewsTable.runId, run.id)).limit(1);
    res.json(
      GetForecastDashboardResponse.parse({
        ...run.modelOutput,
        newsContext: newsSnapshot ? { articles: newsSnapshot.articles, providerErrors: newsSnapshot.providerErrors } : undefined,
        sentimentCoverage: run.modelOutput.sentimentCoverage ?? calculateSentimentCoverage(
          run.rawPosts,
          run.priceBars,
        ),
        latestFailedRun,
      }),
    );
  });

  router.get("/forecast/history", async (req, res): Promise<void> => {
    const query = GetForecastHistoryQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const assetSymbol = query.data.asset.trim().toUpperCase();
    if (!/^[A-Z0-9.^=_-]{1,20}$/.test(assetSymbol)) {
      res.status(400).json({ error: "Use a valid asset ticker." });
      return;
    }
    const runs = await database
      .select()
      .from(researchRunsTable)
      .where(eq(researchRunsTable.assetSymbol, assetSymbol))
      .orderBy(desc(researchRunsTable.startedAt))
      .limit(50);
    res.json(
      GetForecastHistoryResponse.parse(
        runs.map((run) => ({
          id: run.id,
          assetSymbol: run.assetSymbol,
          actorId: run.actorId,
          status: run.status,
          actorRunId: run.actorRunId ?? null,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          postCount: run.postCount,
          priceCount: run.priceCount,
          error: run.error,
        })),
      ),
    );
  });

  router.post("/forecast/import", async (req, res): Promise<void> => {
    const parsed = ImportHistoricalDataBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const assetSymbol = parsed.data.assetSymbol.trim().toUpperCase();
    if (!/^[A-Z0-9.^=_-]{1,20}$/.test(assetSymbol)) {
      res.status(400).json({ error: "Use a valid asset ticker." });
      return;
    }
    let marketMetadata: ReturnType<typeof resolveExchangeMetadata>;
    try { marketMetadata = resolveExchangeMetadata(assetSymbol, undefined, parsed.data.marketCalendar); }
    catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unsupported exchange calendar." });
      return;
    }
    const posts: StoredPost[] = parsed.data.posts.map((post) => ({
      timestamp: post.timestamp.toISOString(),
      text: post.text,
      likes: post.likes ?? 0,
      reposts: post.reposts ?? 0,
      views: post.views ?? 0,
      authorFollowers: post.authorFollowers ?? 0,
      sentimentLabel: post.sentimentLabel ?? null,
    }));
    const priceBars: StoredPriceBar[] = parsed.data.priceBars.map((bar) => ({
      timestamp: bar.timestamp.toISOString(),
      close: bar.close,
    }));
    const [created] = await database
      .insert(researchRunsTable)
      .values({
        assetSymbol,
        actorId: "historical-csv-import",
        marketMetadata,
        searchQuery: "Historical data import",
        lookbackDays: 180,
        maxPosts: Math.max(posts.length, 1),
        costAssumptions: { transactionCostBps: 1, slippageBps: 3, marketImpactBps: 1, annualBorrowRateBps: 300, ...parsed.data.costAssumptions },
        status: "training",
        rawPosts: posts,
        priceBars,
        postCount: posts.length,
        priceCount: priceBars.length,
      })
      .returning();

    try {
      const modelOutput = await forecastModel({
        assetSymbol,
        posts,
        priceBars,
        costAssumptions: parsed.data.costAssumptions,
        marketMetadata,
      });
      await persistDailyFeatures(database, created.id, assetSymbol, modelOutput);
      await persistNewsSnapshot(database, created.id, assetSymbol, collectNews);
      const [completed] = await database
        .update(researchRunsTable)
        .set({ modelOutput, status: "completed", finishedAt: new Date() })
        .where(eq(researchRunsTable.id, created.id))
        .returning();
      res.status(201).json(
        ImportHistoricalDataResponse.parse({
          id: completed.id,
          assetSymbol: completed.assetSymbol,
          actorId: completed.actorId,
          status: completed.status,
          actorRunId: null,
          startedAt: completed.startedAt.toISOString(),
          finishedAt: completed.finishedAt?.toISOString() ?? null,
          postCount: completed.postCount,
          priceCount: completed.priceCount,
          error: null,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Historical model training failed.";
      try {
        await database
          .update(researchRunsTable)
          .set({ status: "failed", error: message, finishedAt: new Date() })
          .where(eq(researchRunsTable.id, created.id));
      } catch (persistenceError) {
        req.log.error({ runId: created.id, error: String(persistenceError) }, "Could not save import failure");
        res.status(503).json({ error: `${message} Failure status could not be saved; reference run ${created.id}.` });
        return;
      }
      req.log.error(
        { runId: created.id, error: message },
        "Historical import model failed",
      );
      res.status(422).json({ error: message });
    }
  });

  router.get("/forecast/report", async (req, res): Promise<void> => {
    const query = GetEvaluationReportQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    if (!/^[0-9a-f-]{36}$/i.test(query.data.runId)) {
      res.status(400).json({ error: "Invalid research run ID." });
      return;
    }
    const [run] = await database
      .select()
      .from(researchRunsTable)
      .where(eq(researchRunsTable.id, query.data.runId))
      .limit(1);
    if (!run || run.status !== "completed" || !run.modelOutput) {
      res
        .status(404)
        .json({ error: "No completed evaluation report exists for that run." });
      return;
    }

    const output = run.modelOutput as Record<string, unknown>;
    const metrics = Array.isArray(output.metrics)
      ? (output.metrics as Array<Record<string, unknown>>)
      : [];
    const forecasts = Array.isArray(output.forecast)
      ? (output.forecast as Array<Record<string, unknown>>)
      : [];
    const performance =
      output.performance && typeof output.performance === "object"
        ? (output.performance as Record<string, unknown>)
        : {};
    const dataWindow =
      output.dataWindow && typeof output.dataWindow === "object"
        ? (output.dataWindow as Record<string, unknown>)
        : {};
    const sentimentCoverage = (output.sentimentCoverage as ReturnType<typeof calculateSentimentCoverage> | undefined) ?? calculateSentimentCoverage(
      run.rawPosts,
      run.priceBars,
    );
    const postDateSpan =
      sentimentCoverage.postStartDate && sentimentCoverage.postEndDate
        ? `${sentimentCoverage.postStartDate} to ${sentimentCoverage.postEndDate} ${output.marketCalendar ?? "UTC"}`
        : "no usable post dates";
    const coverageWarning = sentimentCoverage.isSparse
      ? `WARNING: Social sentiment coverage is sparse: posts were active on ${sentimentCoverage.activePriceDays} of ${sentimentCoverage.priceWindowDays} price days (${(sentimentCoverage.coverageRatio * 100).toFixed(1)}%), across ${sentimentCoverage.activePostDays} active post days (${postDateSpan}). Forecast and evaluation outputs are retained, but sentiment features have limited coverage.`
      : "Social post dates are available across a non-sparse share of the price window.";
    const percent = (value: unknown) =>
      typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "n/a";
    const fixed = (value: unknown, digits = 4) =>
      typeof value === "number" ? value.toFixed(digits) : "n/a";
    const metricRows = metrics
      .map(
        (metric) =>
          `| n+${metric.horizon} | ${fixed(metric.mae, 4)} | ${fixed(metric.rmse, 4)} | ${fixed(metric.r2, 4)} | ${percent(metric.directionalAccuracy)} | ${metric.sampleSize ?? 0} |`,
      )
      .join("\n");
    const forecastRows = forecasts
      .map(
        (forecast) =>
          `| n+${forecast.horizon} | ${fixed(forecast.predictedClose, 2)} | ${percent(forecast.predictedReturn)} | ${fixed(forecast.lowerBound, 2)}–${fixed(forecast.upperBound, 2)} |`,
      )
      .join("\n");
    const [newsSnapshot] = await database.select().from(researchRunNewsTable)
      .where(eq(researchRunNewsTable.runId, run.id)).limit(1);
    const assumptions = performance.assumptions as Record<string, number> | undefined;
    const newsContext = newsSnapshot
      ? `Fetched: ${newsSnapshot.fetchedAt.toISOString()}. This is recent context collected at run time, NOT historical as-of news and NOT a model input.\n${newsSnapshot.articles.map((article) => `- ${article.title}: ${article.url} (${article.publishedAt ?? "date unavailable"})`).join("\n")}\nProvider errors: ${JSON.stringify(newsSnapshot.providerErrors)}`
      : "No run-specific news snapshot is available for this older run.";
    const rl = output.reinforcementLearning as Record<string, unknown> | undefined;
    const quality = output.dataQuality as Record<string, unknown> | undefined;
    const rlSection = rl
      ? `## Reinforcement-learning evaluation\n${JSON.stringify(rl, null, 2)}\n\nThe Q-learning policy is separate from the supervised price regressors. Fixed seeds are ensembled, not selected by test performance. States use prior-session information and execute at the next session close. News and retrospective engagement are excluded.\n`
      : "## Reinforcement-learning evaluation\nNot available in this immutable legacy run. Create a new evaluation to train Q-learning.\n";
    const markdown = `# ${run.assetSymbol} X Sentiment + Price Evaluation

Generated: ${new Date().toISOString()}

## Data window and sources
- Asset: ${run.assetSymbol}
- Window: ${dataWindow.start ?? "unknown"} to ${dataWindow.end ?? "unknown"} (session labels; see calendar below)
- Daily price bars: ${run.priceCount}
- X posts used: ${run.postCount}
- Post date span: ${postDateSpan}
- Active post days: ${sentimentCoverage.activePostDays}
- Price days with posts: ${sentimentCoverage.activePriceDays} of ${sentimentCoverage.priceWindowDays} (${(sentimentCoverage.coverageRatio * 100).toFixed(1)}%)
- Sentiment coverage assessment: ${coverageWarning}
- X source / ingestion identifier: \`${run.actorId}\` (${run.actorRunId ? `Apify run ${run.actorRunId}` : "CSV/corpus import; no Apify scrape for this run"})
- Price source: Yahoo Finance chart endpoint
- Model inputs: ${output.modelVersion ? "lagged prices, returns, rolling volatility, unweighted text sentiment and post volume; snapshot engagement/followers excluded" : "legacy features: lagged prices, returns, rolling volatility, weighted VADER sentiment, post volume and engagement"}
- Recent-news search is shown separately and is not a predictive model feature.
- Search coverage: ${run.searchQuery}
- Alignment calendar: ${output.marketCalendar ?? "UTC daily (legacy run)"}; timezone: ${output.marketTimezone ?? "not recorded (legacy run)"}; exchange: ${output.marketExchange ?? "not recorded"}; resolved from: ${output.marketCalendarSource ?? "legacy output"}. Equity posts after the local exchange close, on weekends, or on holidays belong to the next session.

## News context
${newsContext}

## Collection qualification
${quality ? JSON.stringify(quality, null, 2) : "Not available in this legacy run. Refer to the original coverage assessment."}

## One-page sentiment outlook
${output.outlookMarkdown ?? "No bounded outlook was generated for this legacy run."}

## Historical dataset provenance
${output.provenance ? JSON.stringify(output.provenance, null, 2) : "No external corpus manifest is attached to this run."}
${output.historicalAsOf ? `Historical evaluation as of ${output.historicalAsOf}; these are not current forecasts.` : ""}

## Forecasts
| Horizon | Predicted close | Predicted return | Empirical residual interval |
|---|---:|---:|---:|
${forecastRows}

## Walk-forward out-of-sample performance
Expanding time-ordered folds are used. Future labels are purged from the training folds by the relevant horizon.

| Horizon | MAE (price units) | RMSE (price units) | R² | Directional accuracy | OOS samples |
|---|---:|---:|---:|---:|---:|
${metricRows}

## One-step paper strategy statistics
- Sharpe ratio (annualized, ${performance.annualization ?? 252} trading days): ${fixed(performance.sharpe, 3)}
- Sortino ratio (annualized, ${performance.annualization ?? 252} trading days): ${fixed(performance.sortino, 3)}
- Maximum drawdown: ${percent(performance.maxDrawdown)}
- OOS samples: ${performance.oneStepSampleSize ?? 0}
- Benchmark persistence MAE: ${fixed(performance.baselineMae, 4)}
- Strategy: ${performance.strategy ?? "directional one-step paper strategy"}
- Gross total return: ${percent(performance.grossTotalReturn)}
- Net total return: ${percent(performance.netTotalReturn)}
- Gross Sharpe / Sortino / maximum drawdown: ${fixed(performance.grossSharpe, 3)} / ${fixed(performance.grossSortino, 3)} / ${percent(performance.grossMaxDrawdown)}
- Execution assumptions (one-way bps): commission ${assumptions?.transactionCostBps ?? "not modeled in this legacy run"}, slippage ${assumptions?.slippageBps ?? "n/a"}, market impact ${assumptions?.marketImpactBps ?? "n/a"}.
- Annual short-borrow rate: ${assumptions?.annualBorrowRateBps ?? "not modeled"} bps. Costs apply to position turnover, including entry and final liquidation; short positions incur borrowing costs.

## Method and limitations
- Six horizons are reported: ${output.modelVersion ? "n+0 is a held-back latest-session prediction using only prior-session inputs; n+1 through n+5 are future-session estimates" : "legacy n+0 is the observed close, not a prediction; n+1 through n+5 are future estimates"}. Insufficient-history estimates are unavailable, not fabricated.
- Sentiment is computed from post text with VADER. New runs use unweighted text sentiment; legacy weighting remains unchanged in saved runs.
- New equity runs use the resolved local exchange calendar, including its holidays, DST where observed, and early closes. Supported exchanges: XNYS, XTSE, XLON, XETR, XPAR, XASX, XHKG and XTKS. Recognized crypto pairs use UTC 24/7 days. CSV imports use an explicit user calendar or disclosed ticker convention; unsupported/conflicting metadata is rejected.
- This is a research backtest, not a trading recommendation. Sparse data warnings remain intentional. Configurable costs are illustrative estimates, not executable quotes; real liquidity, borrow availability, taxes, and market impact can differ substantially. These estimates do not make results investable.
- Close-to-close execution is idealized: signals using a finalized close cannot guarantee a fill at that same close.
- Historical public X corpora may end before the live 180-day window. Imported datasets retain their source/license obligations.

${rlSection}
`;
    res.json(
      GetEvaluationReportResponse.parse({
        runId: run.id,
        assetSymbol: run.assetSymbol,
        generatedAt: new Date().toISOString(),
        markdown,
      }),
    );
  });

  return router;
}

export default createForecastRouter();
