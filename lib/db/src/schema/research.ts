import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  date,
  doublePrecision,
  integer,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type StoredPost = {
  timestamp: string;
  text: string;
  likes: number;
  reposts: number;
  views: number;
  authorFollowers: number;
  sentimentLabel: string | null;
};

export type StoredPriceBar = {
  timestamp: string;
  close: number;
};

export type StoredMarketMetadata = {
  calendar: string;
  timeZone: string;
  exchange: string;
  source: "provider" | "ticker" | "user";
};

export type NewsProvider = "Tavily" | "Exa";

export type StoredNewsArticle = {
  title: string;
  url: string;
  publishedAt: string | null;
  source: string;
  snippet: string | null;
  providers: NewsProvider[];
};

export type ForecastCostAssumptions = {
  transactionCostBps: number;
  slippageBps: number;
  marketImpactBps: number;
  annualBorrowRateBps: number;
};

export type StoredDailyFeature = {
  sessionDate: string;
  timestamp: string;
  close: number;
  sentimentScore: number;
  postVolume: number;
  engagement: number;
  return1d: number | null;
};

export type CorpusDailySentiment = {
  sessionDate: string;
  sentimentScore: number;
  postVolume: number;
  engagement: number;
};

export type HistoricalCorpusManifest = {
  id: string;
  title: string;
  sourceUrl: string;
  license: string;
  sha256: string;
  preparedAt: string;
  startDate: string;
  endDate: string;
  sourceRows: number;
  uniqueUsablePosts: number;
  duplicatesRemoved: number;
  invalidRowsRemoved: number;
  sampling: string;
  method: string;
  limitations: string[];
  assets: Record<string, { postCount: number; daily: CorpusDailySentiment[] }>;
};

export const historicalCorporaTable = pgTable("historical_corpora", {
  id: text("id").primaryKey(),
  manifest: jsonb("manifest").$type<HistoricalCorpusManifest>().notNull(),
  archiveObject: text("archive_object").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const researchRunsTable = pgTable("research_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetSymbol: varchar("asset_symbol", { length: 20 }).notNull(),
  actorId: text("actor_id").notNull(),
  actorRunId: text("actor_run_id"),
  marketMetadata: jsonb("market_metadata").$type<StoredMarketMetadata>(),
  searchQuery: text("search_query").notNull(),
  lookbackDays: integer("lookback_days").notNull(),
  maxPosts: integer("max_posts").notNull(),
  costAssumptions: jsonb("cost_assumptions")
    .$type<ForecastCostAssumptions>()
    .notNull()
    .default({
      transactionCostBps: 1,
      slippageBps: 3,
      marketImpactBps: 1,
      annualBorrowRateBps: 300,
    }),
  status: varchar("status", { length: 20 }).notNull(),
  workerToken: text("worker_token"),
  workerLeaseUntil: timestamp("worker_lease_until", { withTimezone: true }),
  workerRetryAt: timestamp("worker_retry_at", { withTimezone: true }),
  workerFailures: integer("worker_failures").notNull().default(0),
  workerLastError: text("worker_last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  postCount: integer("post_count").notNull().default(0),
  priceCount: integer("price_count").notNull().default(0),
  rawPosts: jsonb("raw_posts").$type<StoredPost[]>().notNull().default([]),
  priceBars: jsonb("price_bars").$type<StoredPriceBar[]>().notNull().default([]),
  modelOutput: jsonb("model_output").$type<Record<string, unknown> | null>(),
  error: text("error"),
}, (table) => [
  index("research_runs_completion_queue_idx").on(
    table.status, table.workerRetryAt, table.workerLeaseUntil, table.startedAt,
  ),
]);

export const researchDailyFeaturesTable = pgTable(
  "research_daily_features",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRunsTable.id, { onDelete: "cascade" }),
    assetSymbol: varchar("asset_symbol", { length: 20 }).notNull(),
    sessionDate: date("session_date", { mode: "string" }).notNull(),
    barTimestamp: timestamp("bar_timestamp", { withTimezone: true }).notNull(),
    close: doublePrecision("close").notNull(),
    sentimentScore: doublePrecision("sentiment_score").notNull(),
    postVolume: integer("post_volume").notNull(),
    engagement: doublePrecision("engagement").notNull(),
    return1d: doublePrecision("return_1d"),
  },
  (table) => [
    uniqueIndex("research_daily_features_run_date_idx").on(
      table.runId,
      table.sessionDate,
    ),
  ],
);

export const researchRunNewsTable = pgTable("research_run_news", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => researchRunsTable.id, { onDelete: "cascade" }),
  articles: jsonb("articles").$type<StoredNewsArticle[]>().notNull().default([]),
  providerErrors: jsonb("provider_errors")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertResearchRunSchema = createInsertSchema(researchRunsTable).omit({
  id: true,
  startedAt: true,
});
export type InsertResearchRun = z.infer<typeof insertResearchRunSchema>;
export type ResearchRun = typeof researchRunsTable.$inferSelect;

export const newsCacheTable = pgTable("asset_news_cache", {
  assetSymbol: varchar("asset_symbol", { length: 20 }).primaryKey(),
  articles: jsonb("articles").$type<StoredNewsArticle[]>().notNull().default([]),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});
