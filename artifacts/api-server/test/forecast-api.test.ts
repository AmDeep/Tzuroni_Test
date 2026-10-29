import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { researchRunsTable, researchRunNewsTable, researchDailyFeaturesTable, historicalCorporaTable, type db } from "@workspace/db";
import { randomUUID } from "node:crypto";
import { createHistoricalCorpusRouter, CORPUS_ID } from "../src/routes/historical-corpus";
import { buildAssetSearchTerms } from "../src/lib/forecasting";
import {
  GetForecastDashboardQueryParams,
  GetForecastDashboardResponse,
  GetEvaluationReportQueryParams,
  GetForecastHistoryQueryParams,
  GetResearchRunParams,
  GetResearchRunResponse,
  ImportHistoricalDataBody,
  StartResearchRunBody,
} from "@workspace/api-zod";
import { createForecastRouter } from "../src/routes/forecast";
import { createResearchRouter } from "../src/routes/research";

const openApi = readFileSync(
  resolve(process.cwd(), "../../lib/api-spec/openapi.yaml"),
  "utf8",
);

function getPathSpec(path: string): string {
  const start = openApi.indexOf(`  ${path}:\n`);
  assert.notEqual(start, -1, `OpenAPI spec is missing ${path}`);
  const nextPath = openApi.indexOf("\n  /", start + 1);
  return openApi.slice(start, nextPath === -1 ? undefined : nextPath);
}

const runId = "11111111-1111-4111-8111-111111111111";
const failedRunId = "22222222-2222-4222-8222-222222222222";
const olderRunId = "33333333-3333-4333-8333-333333333333";
const unexpectedFailureRunId = "44444444-4444-4444-8444-444444444444";
const concurrentCompletedRunId = "66666666-6666-4666-8666-666666666666";
const concurrentFailedRunId = "77777777-7777-4777-8777-777777777777";
const modelOutput = {
  assetSymbol: "TEST",
  status: "ready",
  hasData: true,
  lastUpdated: "2025-04-10T00:00:00.000Z",
  currentPrice: 100,
  sentimentScore: 0,
  sentimentLabel: "neutral",
  postCount: 0,
  priceCount: 20,
  series: [],
  forecast: Array.from({ length: 6 }, (_, horizon) => ({
    horizon,
    predictedClose: 100 + horizon,
    predictedReturn: horizon / 100,
    lowerBound: 99 + horizon,
    upperBound: 101 + horizon,
  })),
  sentimentCoverage: {
    postStartDate: "2025-01-10",
    postEndDate: "2025-01-10",
    activePostDays: 1,
    activePriceDays: 1,
    priceWindowDays: 20,
    coverageRatio: 0.05,
    isSparse: true,
  },
  marketCalendar: "XNYS",
  alignedDailyData: [{
    sessionDate: "2025-01-10", timestamp: "2025-01-10T00:00:00Z",
    close: 109, sentimentScore: 0, postVolume: 1, engagement: 0, return1d: 0.01,
  }],
  metrics: Array.from({ length: 5 }, (_, index) => ({
    horizon: index + 1,
    mae: 1.25 + index,
    rmse: 2.5 + index,
    r2: 0.5,
    directionalAccuracy: 0.6,
    sampleSize: 18,
  })),
  performance: {
    sharpe: 1.234,
    sortino: 1.567,
    maxDrawdown: -0.1234,
    oneStepSampleSize: 18,
    baselineMae: 3.25,
    strategy: "directional test strategy",
    transactionCostsBps: 0,
  },
  dataWindow: { start: "2025-01-01", end: "2025-01-20" },
  summary: "Forecast test output.",
};

function createFakeDatabase() {
  const storedRuns: Record<string, any>[] = [];
  let insertCount = 0;
  const generatedRunIds = [
    runId,
    failedRunId,
    unexpectedFailureRunId,
    "55555555-5555-4555-8555-555555555555",
    concurrentCompletedRunId,
    concurrentFailedRunId,
  ];
  let returnNoRows = false;
  const collectParams = (value: unknown, params: unknown[] = [], seen = new Set<object>()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return params;
    seen.add(value);
    const candidate = value as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
    if (candidate.constructor?.name === "Param") {
      params.push(candidate.value);
    } else if (Array.isArray(candidate.queryChunks)) {
      for (const chunk of candidate.queryChunks) collectParams(chunk, params, seen);
    }
    return params;
  };
  const applyUpdates = (updates: Record<string, unknown>, id?: string) => {
    const storedRun = storedRuns.find((run) => !id || run.id === id);
    if (storedRun) Object.assign(storedRun, updates);
    return storedRun;
  };
  const selectedRows = (params: unknown[], limit: number) => {
    if (returnNoRows) return [];
    const strings = params.filter((value): value is string => typeof value === "string");
    const id = strings.find((value) => /^[0-9a-f-]{36}$/i.test(value));
    const status = strings.find((value) => ["completed", "failed"].includes(value));
    const assetSymbol = strings.find(
      (value) => !/^[0-9a-f-]{36}$/i.test(value) && !["completed", "failed"].includes(value),
    );
    return storedRuns
      .filter((run) => (!id || run.id === id) && (!status || run.status === status) && (!assetSymbol || run.assetSymbol === assetSymbol))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  };

  const artifacts = new Map<unknown, Array<Record<string, any>>>();
  const database = {
    select: () => ({
      from: (table: unknown) => {
        let params: unknown[] = [];
        const query: any = {
          where: (condition: unknown) => {
            params = collectParams(condition);
            return query;
          },
          orderBy: () => query,
          limit: async (limit: number) => table === researchRunsTable ? selectedRows(params, limit) : (artifacts.get(table) ?? []).filter((row) => params.includes(row.runId ?? row.id)).slice(0, limit),
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table !== researchRunsTable) {
          artifacts.set(table, [...(artifacts.get(table) ?? []), ...(Array.isArray(values) ? values : [values])]);
          return Promise.resolve();
        }
        insertCount += 1;
        const storedRun = {
          ...values,
          id: generatedRunIds[insertCount - 1] ?? randomUUID(),
          startedAt: new Date(Date.UTC(2025, 3, 10, 0, 0, insertCount - 1)),
          finishedAt: null,
          modelOutput: null,
          error: null,
        };
        storedRuns.push(storedRun);
        return { returning: async () => [storedRun] };
      },
    }),
    update: () => ({
      set: (updates: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const id = collectParams(condition).find(
            (value): value is string => typeof value === "string" && storedRuns.some((run) => run.id === value),
          );
          const updatedRun = applyUpdates(updates, id);
          return {
            returning: async () => (updatedRun ? [updatedRun] : []),
            then: (
              resolve: (value: Record<string, any> | undefined) => unknown,
              reject: (reason: unknown) => unknown,
            ) => Promise.resolve(updatedRun).then(resolve, reject),
          };
        },
      }),
    }),
  };
  return {
    artifacts,
    database: database as unknown as typeof db,
    get insertCount() {
      return insertCount;
    },
    get storedRun() {
      return storedRuns.at(-1);
    },
    seedRun(run: Record<string, any>) {
      storedRuns.push(run);
    },
    set returnNoRows(value: boolean) {
      returnNoRows = value;
    },
  };
}

const fake = createFakeDatabase();
let trainingError: unknown;
let retryModelOutput: typeof modelOutput | undefined;
let lastForecastPayload: { marketMetadata?: unknown } | undefined;
let modelRunCount = 0;
type ControlledImport = {
  started: Promise<void>;
  markStarted: () => void;
  completion: Promise<void>;
  finish: () => void;
  error?: Error;
  output: typeof modelOutput;
};
const controlledImports = new Map<string, ControlledImport>();
function createControlledImport(
  output: typeof modelOutput,
  error?: Error,
): ControlledImport {
  let markStarted!: () => void;
  let finish!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    markStarted: () => markStarted(),
    completion: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    finish: () => finish(),
    error,
    output,
  };
}
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as typeof req & { log: { error: () => void } }).log = {
    error: () => {},
  };
  next();
});
app.use(
  createForecastRouter({
    database: fake.database,
    collectNews: async () => ({ articles: [], providerErrors: { tavily: "Fixture provider outage" } }),
    forecastModel: async (payload) => {
      lastForecastPayload = payload;
      const { posts } = payload;
      modelRunCount += 1;
      const controlledImport = controlledImports.get(posts[0]?.text ?? "");
      if (controlledImport) {
        controlledImport.markStarted();
        await controlledImport.completion;
        if (controlledImport.error) throw controlledImport.error;
        return controlledImport.output as never;
      }
      if (trainingError) {
        throw trainingError;
      }
      const output = retryModelOutput ?? modelOutput;
      retryModelOutput = undefined;
      return output as never;
    },
  }),
);
app.use(createResearchRouter({ database: fake.database }));
let corpusModelPayload: Record<string, unknown> | undefined;
let corpusModelError = false;
app.use(createHistoricalCorpusRouter({
  database: fake.database,
  fetchPrices: async () => validImportBody().priceBars,
  forecastModel: async (payload) => {
    corpusModelPayload = payload;
    if (corpusModelError) throw new Error("Fixture corpus training failure");
    return { ...modelOutput, postCount: 1 } as never;
  },
  collectNews: async () => ({ articles: [], providerErrors: {} }),
}));
let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function validImportBody(postText = "test post") {
  return {
    assetSymbol: " test ",
    posts: [{ timestamp: "2025-01-10T08:00:00.000Z", text: postText }],
    priceBars: Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      close: 100 + index,
    })),
  };
}

test("invalid research-run requests return the documented error response", async () => {
  const invalidBodies = [
    {},
    { assetSymbol: "TEST", searchQuery: "x".repeat(301) },
    { assetSymbol: "BAD!", searchQuery: "market news" },
    { assetSymbol: "TEST", searchQuery: "market news", actorId: "bad.actor" },
    { assetSymbol: "TEST", searchQuery: "market news", lookbackDays: 181 },
    { assetSymbol: "TEST", searchQuery: "market news", maxPosts: 49 },
  ];
  const insertsBefore = fake.insertCount;

  for (const body of invalidBodies) {
    const response = await fetch(`${baseUrl}/research/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.deepEqual(Object.keys(error), ["error"]);
    assert.equal(typeof error.error, "string");
  }
  assert.equal(fake.insertCount, insertsBefore);
});

test("research-run lookup returns its documented not-found response", async () => {
  const missingRunId = "55555555-5555-4555-8555-555555555555";
  assert.equal(GetResearchRunParams.safeParse({ runId: "missing-run" }).success, true);

  const response = await fetch(`${baseUrl}/research/runs/${missingRunId}`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Research run not found." });
});

test("research-run polling reads status without finalizing or calling Apify", async () => {
  const readOnlyRunId = randomUUID();
  fake.seedRun({
    id: readOnlyRunId, assetSymbol: "READONLY", actorId: "fixture",
    actorRunId: "not-a-real-actor-run", status: "scraping", postCount: 0, priceCount: 20,
    startedAt: new Date(), finishedAt: null, error: null,
  });
  const response = await fetch(`${baseUrl}/research/runs/${readOnlyRunId}`);
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.status, "scraping");
  assert.equal(run.actorRunId, "not-a-real-actor-run");
});

test("historical import rejects malformed and undersized data before persistence", async () => {
  const tooFewBars = validImportBody();
  tooFewBars.priceBars = tooFewBars.priceBars.slice(0, 19);
  const invalidClose = validImportBody();
  invalidClose.priceBars[0].close = 0;
  const invalidTimestamp = validImportBody();
  invalidTimestamp.posts = [{ timestamp: "not-a-date", text: "post" }];
  const invalidTicker = validImportBody();
  invalidTicker.assetSymbol = "TEST!";
  const tooManyBars = validImportBody();
  tooManyBars.priceBars = Array.from({ length: 1001 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    close: 100 + index,
  }));

  for (const body of [
    tooFewBars,
    invalidClose,
    invalidTimestamp,
    invalidTicker,
    tooManyBars,
  ]) {
    const response = await fetch(`${baseUrl}/forecast/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal(fake.insertCount, 0);
});

test("historical import is normalized and its completed run report is retrievable", async () => {
  const response = await fetch(`${baseUrl}/forecast/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validImportBody()),
  });
  assert.equal(response.status, 201);
  const imported = await response.json();
  assert.equal(imported.id, runId);
  assert.equal(imported.assetSymbol, "TEST");
  assert.equal(imported.status, "completed");
  assert.equal(imported.priceCount, 20);
  assert.equal(imported.postCount, 1);
  const features = fake.artifacts.get(researchDailyFeaturesTable) ?? [];
  assert.equal(features.length, 1);
  assert.equal(features[0].runId, runId);
  assert.equal(features[0].sessionDate, "2025-01-10");
  const newsSnapshot = fake.artifacts.get(researchRunNewsTable)?.[0];
  assert.equal(newsSnapshot?.runId, runId);
  assert.equal(newsSnapshot?.providerErrors.tavily, "Fixture provider outage");
  assert.equal(
    fake.storedRun?.priceBars[0].timestamp,
    "2025-01-01T00:00:00.000Z",
  );

  const researchRunResponse = await fetch(
    `${baseUrl}/research/runs/${encodeURIComponent(runId)}`,
  );
  assert.equal(researchRunResponse.status, 200);
  assert.equal(
    GetResearchRunResponse.safeParse(await researchRunResponse.json()).success,
    true,
  );

  const dashboardResponse = await fetch(
    `${baseUrl}/forecast/dashboard?asset=${encodeURIComponent(" test ")}`,
  );
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.assetSymbol, "TEST");
  assert.equal(GetForecastDashboardResponse.safeParse(dashboard).success, true);
  assert.equal(dashboard.marketCalendar, "XNYS");
  assert.equal(dashboard.newsContext.providerErrors.tavily, "Fixture provider outage");
  assert.deepEqual(dashboard.sentimentCoverage, {
    postStartDate: "2025-01-10",
    postEndDate: "2025-01-10",
    activePostDays: 1,
    activePriceDays: 1,
    priceWindowDays: 20,
    coverageRatio: 0.05,
    isSparse: true,
  });

  const reportResponse = await fetch(
    `${baseUrl}/forecast/report?runId=${encodeURIComponent(runId)}`,
  );
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.runId, runId);
  assert.equal(report.assetSymbol, "TEST");
  for (const field of [
    "## Forecasts",
    "| n+0 | 100.00 | 0.00%",
    "| n+5 |",
    "## Walk-forward out-of-sample performance",
    "| n+1 |",
    "| n+5 |",
    "Sharpe ratio (annualized, 252 trading days): 1.234",
    "Sortino ratio (annualized, 252 trading days): 1.567",
    "Maximum drawdown: -12.34%",
    "- Post date span: 2025-01-10 to 2025-01-10 XNYS",
    "- Active post days: 1",
    "WARNING: Social sentiment coverage is sparse: posts were active on 1 of 20 price days (5.0%)",
    "Forecast and evaluation outputs are retained, but sentiment features have limited coverage.",
    "Benchmark persistence MAE: 3.2500",
    "Historical public X corpora may end before the live 180-day window",
  ]) {
    assert.ok(
      report.markdown.includes(field),
      `report is missing Markdown field: ${field}`,
    );
  }
});

test("dashboard enforces documented ticker constraints and returns its response schema", async () => {
  for (const asset of ["", "TEST!", "A".repeat(21)]) {
    const response = await fetch(
      `${baseUrl}/forecast/dashboard?asset=${encodeURIComponent(asset)}`,
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
  }

  const response = await fetch(
    `${baseUrl}/forecast/dashboard?asset=${encodeURIComponent(" test ")}`,
  );
  assert.equal(response.status, 200);
  const dashboard = await response.json();
  assert.equal(dashboard.assetSymbol, "TEST");
  assert.equal(GetForecastDashboardResponse.safeParse(dashboard).success, true);
});

test("historical import persists training failures and has no evaluation report", async () => {
  const failureMessage = "Model training failed: insufficient usable observations.";
  trainingError = new Error(failureMessage);
  const runsBefore = modelRunCount;

  try {
    const response = await fetch(`${baseUrl}/forecast/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validImportBody()),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: failureMessage });
    assert.equal(modelRunCount, runsBefore + 1);
    assert.equal(fake.storedRun?.status, "failed");
    assert.equal(fake.storedRun?.error, failureMessage);
    assert.equal(fake.storedRun?.modelOutput, null);

    const dashboardResponse = await fetch(
      `${baseUrl}/forecast/dashboard?asset=TEST`,
    );
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.status, "ready");
    assert.deepEqual(dashboard.forecast, modelOutput.forecast);
    assert.deepEqual(dashboard.latestFailedRun, {
      id: failedRunId,
      status: "failed",
      error: failureMessage,
      startedAt: "2025-04-10T00:00:01.000Z",
      finishedAt: dashboard.latestFailedRun.finishedAt,
    });
    assert.equal(typeof dashboard.latestFailedRun.finishedAt, "string");

    const reportResponse = await fetch(
      `${baseUrl}/forecast/report?runId=${encodeURIComponent(failedRunId)}`,
    );
    assert.equal(reportResponse.status, 404);
  } finally {
    trainingError = undefined;
  }
});

test("forecast history lists failed runs and selecting an older run loads its dashboard and report", async () => {
  const olderModelOutput = {
    ...modelOutput,
    currentPrice: 80,
    summary: "Earlier forecast run.",
    forecast: modelOutput.forecast.map((point) => ({
      ...point,
      predictedClose: 80 + point.horizon,
    })),
  };
  fake.seedRun({
    id: olderRunId,
    assetSymbol: "TEST",
    actorId: "historical-csv-import",
    actorRunId: null,
    searchQuery: "Older fixture",
    lookbackDays: 180,
    maxPosts: 2,
    status: "completed",
    startedAt: new Date(Date.UTC(2025, 3, 8)),
    finishedAt: new Date(Date.UTC(2025, 3, 8, 0, 1)),
    postCount: 2,
    priceCount: 20,
    rawPosts: [],
    priceBars: Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      close: 80 + index,
    })),
    modelOutput: olderModelOutput,
    error: null,
  });

  const historyResponse = await fetch(
    `${baseUrl}/forecast/history?asset=TEST`,
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.deepEqual(
    history.map((item: { id: string; status: string }) => [
      item.id,
      item.status,
    ]),
    [
      [failedRunId, "failed"],
      [runId, "completed"],
      [olderRunId, "completed"],
    ],
  );
  assert.match(history[0].error, /insufficient usable observations/);

  const latestDashboardResponse = await fetch(
    `${baseUrl}/forecast/dashboard?asset=TEST`,
  );
  const latestDashboard = await latestDashboardResponse.json();
  assert.equal(latestDashboard.currentPrice, 100);

  const selectedDashboardResponse = await fetch(
    `${baseUrl}/forecast/dashboard?asset=TEST&runId=${encodeURIComponent(olderRunId)}`,
  );
  assert.equal(selectedDashboardResponse.status, 200);
  const selectedDashboard = await selectedDashboardResponse.json();
  assert.equal(selectedDashboard.currentPrice, 80);
  assert.equal(selectedDashboard.summary, "Earlier forecast run.");
  assert.equal(selectedDashboard.forecast[0].predictedClose, 80);

  const selectedReportResponse = await fetch(
    `${baseUrl}/forecast/report?runId=${encodeURIComponent(olderRunId)}`,
  );
  assert.equal(selectedReportResponse.status, 200);
  const selectedReport = await selectedReportResponse.json();
  assert.equal(selectedReport.runId, olderRunId);
  assert.ok(selectedReport.markdown.includes("| n+0 | 80.00 |"));

  const wrongAssetResponse = await fetch(
    `${baseUrl}/forecast/dashboard?asset=OTHER&runId=${encodeURIComponent(olderRunId)}`,
  );
  assert.equal(wrongAssetResponse.status, 404);
});

test("successful retry becomes current while repeated failed attempts stay in history", async () => {
  const firstFailureMessage = "Model training failed: insufficient usable observations.";
  const fallbackMessage = "Historical model training failed.";
  trainingError = { reason: "unexpected rejection value" };
  const runsBefore = modelRunCount;

  try {
    const response = await fetch(`${baseUrl}/forecast/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validImportBody()),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: fallbackMessage });
    assert.equal(modelRunCount, runsBefore + 1);
    assert.equal(fake.storedRun?.id, unexpectedFailureRunId);
    assert.equal(fake.storedRun?.status, "failed");
    assert.equal(fake.storedRun?.error, fallbackMessage);
    assert.equal(fake.storedRun?.modelOutput, null);

    const dashboardResponse = await fetch(
      `${baseUrl}/forecast/dashboard?asset=TEST`,
    );
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.status, "ready");
    assert.equal(dashboard.currentPrice, modelOutput.currentPrice);
    assert.deepEqual(dashboard.forecast, modelOutput.forecast);
    assert.equal(dashboard.latestFailedRun.id, unexpectedFailureRunId);
    assert.equal(dashboard.latestFailedRun.status, "failed");
    assert.equal(dashboard.latestFailedRun.error, fallbackMessage);
    assert.notEqual(dashboard.latestFailedRun.id, failedRunId);
    assert.equal(
      dashboard.latestFailedRun.startedAt,
      "2025-04-10T00:00:02.000Z",
    );

    const reportResponse = await fetch(
      `${baseUrl}/forecast/report?runId=${encodeURIComponent(unexpectedFailureRunId)}`,
    );
    assert.equal(reportResponse.status, 404);

    trainingError = undefined;
    const retryForecast = modelOutput.forecast.map((point) => ({
      ...point,
      predictedClose: point.predictedClose + 25,
    }));
    retryModelOutput = {
      ...modelOutput,
      currentPrice: 175,
      summary: "Successful recovery forecast.",
      forecast: retryForecast,
    };
    const retryResponse = await fetch(`${baseUrl}/forecast/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validImportBody()),
    });
    const retry = await retryResponse.json();
    assert.equal(retryResponse.status, 201, JSON.stringify(retry));
    assert.notEqual(retry.id, runId);
    assert.notEqual(retry.id, failedRunId);
    assert.notEqual(retry.id, unexpectedFailureRunId);
    assert.equal(retry.status, "completed");
    assert.equal(fake.storedRun?.id, retry.id);
    assert.equal(fake.storedRun?.status, "completed");

    const recoveredDashboardResponse = await fetch(
      `${baseUrl}/forecast/dashboard?asset=TEST`,
    );
    assert.equal(recoveredDashboardResponse.status, 200);
    const recoveredDashboard = await recoveredDashboardResponse.json();
    assert.equal(recoveredDashboard.currentPrice, 175);
    assert.deepEqual(recoveredDashboard.forecast, retryForecast);
    assert.equal(recoveredDashboard.summary, "Successful recovery forecast.");
    assert.equal(recoveredDashboard.latestFailedRun.id, unexpectedFailureRunId);
    assert.equal(recoveredDashboard.latestFailedRun.error, fallbackMessage);

    const retryReportResponse = await fetch(
      `${baseUrl}/forecast/report?runId=${encodeURIComponent(retry.id)}`,
    );
    assert.equal(retryReportResponse.status, 200);
    assert.equal((await retryReportResponse.json()).runId, retry.id);

    const historyResponse = await fetch(`${baseUrl}/forecast/history?asset=TEST`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();
    const failedHistory = history.filter((run: { status: string }) => run.status === "failed");
    assert.ok(failedHistory.some((run: { id: string; error: string }) => run.id === failedRunId && run.error === firstFailureMessage));
    assert.ok(failedHistory.some((run: { id: string; error: string }) => run.id === unexpectedFailureRunId && run.error === fallbackMessage));
    assert.ok(history.some((run: { id: string; status: string }) => run.id === retry.id && run.status === "completed"));
  } finally {
    trainingError = undefined;
    retryModelOutput = undefined;
  }
});

test("concurrent imports keep the latest completed forecast and newest failure", async () => {
  const completedPost = "controlled older import that succeeds";
  const failedPost = "controlled newer import that fails";
  const failureMessage = "Newer import failed during model training.";
  const completedOutput = {
    ...modelOutput,
    currentPrice: 111,
  };
  const completedGate = createControlledImport(completedOutput);
  const failedGate = createControlledImport(
    modelOutput,
    new Error(failureMessage),
  );
  controlledImports.set(completedPost, completedGate);
  controlledImports.set(failedPost, failedGate);

  const startImport = (postText: string) =>
    fetch(`${baseUrl}/forecast/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validImportBody(postText)),
    });

  try {
    const completedImport = startImport(completedPost);
    await completedGate.started;

    const failedImport = startImport(failedPost);
    await failedGate.started;

    // The later-started failure finishes before the earlier successful run.
    failedGate.finish();
    const failedResponse = await failedImport;
    assert.equal(failedResponse.status, 422);
    assert.deepEqual(await failedResponse.json(), { error: failureMessage });

    completedGate.finish();
    const completedResponse = await completedImport;
    assert.equal(completedResponse.status, 201);
    const completedRun = await completedResponse.json();
    assert.equal(completedRun.id, concurrentCompletedRunId);
    assert.equal(completedRun.status, "completed");

    const dashboardResponse = await fetch(
      `${baseUrl}/forecast/dashboard?asset=TEST`,
    );
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.status, "ready");
    assert.equal(dashboard.currentPrice, completedOutput.currentPrice);
    assert.deepEqual(dashboard.forecast, modelOutput.forecast);
    assert.deepEqual(dashboard.latestFailedRun, {
      id: concurrentFailedRunId,
      status: "failed",
      error: failureMessage,
      startedAt: "2025-04-10T00:00:05.000Z",
      finishedAt: dashboard.latestFailedRun.finishedAt,
    });
    assert.equal(typeof dashboard.latestFailedRun.finishedAt, "string");
  } finally {
    completedGate.finish();
    failedGate.finish();
    controlledImports.delete(completedPost);
    controlledImports.delete(failedPost);
  }
});

test("report retrieval rejects malformed IDs and returns 404 for missing runs", async () => {
  const malformed = await fetch(`${baseUrl}/forecast/report?runId=not-a-uuid`);
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, "string");
  fake.returnNoRows = true;
  const missing = await fetch(
    `${baseUrl}/forecast/report?runId=22222222-2222-4222-8222-222222222222`,
  );
  fake.returnNoRows = false;
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, "string");
});

test("forecast OpenAPI request constraints and error responses match runtime schemas", () => {
  const importPath = getPathSpec("/forecast/import");
  const reportPath = getPathSpec("/forecast/report");
  const dashboardPath = getPathSpec("/forecast/dashboard");
  const historyPath = getPathSpec("/forecast/history");
  const dashboardSchema = openApi
    .split("    ForecastDashboard:\n")[1]
    ?.split("\n    SentimentCoverage:")[0];
  const importSchema = openApi
    .split("    HistoricalImportInput:\n")[1]
    ?.split("\n    NewsSearchInput:")[0];
  assert.ok(importSchema, "OpenAPI spec is missing HistoricalImportInput");
  assert.ok(dashboardSchema, "OpenAPI spec is missing ForecastDashboard");
  assert.match(dashboardSchema, /latestFailedRun:[\s\S]*?FailedRunSummary/);
  const priceBarSchema = openApi
    .split("    PriceBarInput:\n")[1]
    ?.split("\n    HistoricalImportInput:")[0];
  assert.ok(priceBarSchema, "OpenAPI spec is missing PriceBarInput");

  assert.match(importPath, /HistoricalImportInput/);
  assert.match(importPath, /"201":[\s\S]*?ResearchRun/);
  assert.match(importPath, /"400":[\s\S]*?ErrorResponse/);
  assert.match(importPath, /"422":[\s\S]*?ErrorResponse/);
  assert.match(dashboardSchema, /sentimentCoverage:[\s\S]*?SentimentCoverage/);
  assert.match(reportPath, /minLength: 36/);
  assert.match(reportPath, /maxLength: 36/);
  assert.match(reportPath, /pattern: '\^\[0-9a-fA-F-\]\{36\}\$'/);
  assert.match(reportPath, /"400":[\s\S]*?ErrorResponse/);
  assert.match(reportPath, /"404":[\s\S]*?ErrorResponse/);
  assert.match(dashboardPath, /name: asset/);
  assert.match(dashboardPath, /required: true/);
  assert.match(dashboardPath, /minLength: 1/);
  assert.match(dashboardPath, /maxLength: 20/);
  assert.ok(
    dashboardPath.includes("pattern: '^\\s*[A-Za-z0-9.^=_-]+\\s*$'"),
  );
  assert.match(dashboardPath, /"200":[\s\S]*?ForecastDashboard/);
  assert.match(dashboardPath, /"400":[\s\S]*?ErrorResponse/);
  assert.match(dashboardPath, /name: runId/);
  assert.match(dashboardPath, /"404":[\s\S]*?ErrorResponse/);
  assert.match(historyPath, /ResearchRun/);
  assert.match(historyPath, /"400":[\s\S]*?ErrorResponse/);
  assert.match(importSchema, /minItems: 20/);
  assert.match(importSchema, /maxItems: 1000/);
  assert.match(importSchema, /maxItems: 10000/);
  assert.match(priceBarSchema, /exclusiveMinimum: 0/);

  assert.equal(ImportHistoricalDataBody.safeParse(validImportBody()).success, true);
  assert.equal(
    ImportHistoricalDataBody.safeParse({
      ...validImportBody(),
      priceBars: validImportBody().priceBars.slice(0, 19),
    }).success,
    false,
  );
  assert.equal(GetEvaluationReportQueryParams.safeParse({ runId }).success, true);
  assert.equal(
    GetEvaluationReportQueryParams.safeParse({ runId: "not-a-uuid" }).success,
    false,
  );
  assert.equal(
    GetForecastDashboardQueryParams.safeParse({ asset: "TEST", runId }).success,
    true,
  );
  assert.equal(
    GetForecastDashboardQueryParams.safeParse({ asset: " test " }).success,
    true,
  );
  for (const asset of ["", "TEST!", "A".repeat(21)]) {
    assert.equal(
      GetForecastDashboardQueryParams.safeParse({ asset }).success,
      false,
    );
  }
  assert.equal(
    GetForecastDashboardQueryParams.safeParse({
      asset: "TEST",
      runId: "bad-id",
    }).success,
    false,
  );
  assert.equal(
    GetForecastHistoryQueryParams.safeParse({ asset: "TEST" }).success,
    true,
  );
});

test("research-run OpenAPI constraints and errors match generated schemas", () => {
  const createPath = getPathSpec("/research/runs");
  const lookupPath = getPathSpec("/research/runs/{runId}");
  const inputSchema = openApi
    .split("    ResearchRunInput:\n")[1]
    ?.split("\n    ResearchRun:\n")[0];
  const errorSchema = openApi
    .split("    ErrorResponse:\n")[1]
    ?.split("\n    NewsProviderErrors:\n")[0];

  assert.ok(inputSchema, "OpenAPI spec is missing ResearchRunInput");
  assert.ok(errorSchema, "OpenAPI spec is missing ErrorResponse");
  assert.match(createPath, /requestBody:[\s\S]*?ResearchRunInput/);
  assert.match(createPath, /"202":[\s\S]*?ResearchRun/);
  assert.match(createPath, /"400":[\s\S]*?ErrorResponse/);
  assert.match(lookupPath, /name: runId/);
  assert.match(lookupPath, /required: true/);
  assert.match(lookupPath, /"200":[\s\S]*?ResearchRun/);
  assert.match(lookupPath, /"404":[\s\S]*?ErrorResponse/);
  assert.match(inputSchema, /assetSymbol:[\s\S]*?minLength: 1[\s\S]*?maxLength: 20/);
  assert.ok(
    inputSchema.includes("pattern: '^\\s*[A-Za-z0-9.^=_-]+\\s*$'"),
  );
  assert.match(inputSchema, /searchQuery:[\s\S]*?maxLength: 300/);
  assert.match(inputSchema, /actorId:[\s\S]*?minLength: 1[\s\S]*?maxLength: 120/);
  assert.ok(inputSchema.includes("pattern: '^[A-Za-z0-9_~-]{1,120}$'"));
  assert.match(inputSchema, /lookbackDays:[\s\S]*?minimum: 1[\s\S]*?maximum: 180/);
  assert.match(inputSchema, /maxPosts:[\s\S]*?minimum: 50[\s\S]*?maximum: 5000/);
  assert.match(errorSchema, /error:[\s\S]*?type: string/);
  assert.match(errorSchema, /required: \[error\]/);

  assert.equal(
    StartResearchRunBody.safeParse({ assetSymbol: "TSLA", searchQuery: "market" }).success,
    true,
  );
  for (const body of [
    {},
    { assetSymbol: "TEST", searchQuery: "x".repeat(301) },
    { assetSymbol: "BAD!", searchQuery: "market news" },
    { assetSymbol: "TEST", searchQuery: "market news", actorId: "bad.actor" },
    { assetSymbol: "TEST", searchQuery: "market news", lookbackDays: 181 },
    { assetSymbol: "TEST", searchQuery: "market news", maxPosts: 49 },
  ]) {
    assert.equal(StartResearchRunBody.safeParse(body).success, false);
  }
  assert.equal(GetResearchRunParams.safeParse({ runId: "missing-run" }).success, true);
});

test("search coverage automatically includes ticker, cashtag and keyword queries", () => {
  assert.deepEqual(buildAssetSearchTerms("TSLA", undefined, "Tesla"), ["TSLA", "$TSLA", "Tesla"]);
  assert.deepEqual(buildAssetSearchTerms("BTC-USD"), ["BTC", "$BTC", "BTC cryptocurrency"]);
  assert.deepEqual(buildAssetSearchTerms("AAPL", "AAPL", "Apple"), ["AAPL", "$AAPL", "Apple"]);
  assert.equal(StartResearchRunBody.safeParse({ assetSymbol: "AAPL" }).success, true);
  assert.equal(StartResearchRunBody.safeParse({ assetSymbol: "AAPL", costAssumptions: { slippageBps: -1 } }).success, false);
  assert.equal(ImportHistoricalDataBody.safeParse({ ...validImportBody(), costAssumptions: { marketImpactBps: 5001 } }).success, false);
});

test("corpus import requires installed data and a supported company", async () => {
  const status = await fetch(`${baseUrl}/forecast/corpus`);
  assert.deepEqual(await status.json(), { available: false, assets: [] });
  const missing = await fetch(`${baseUrl}/forecast/corpus/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetSymbol: "TSLA" }) });
  assert.equal(missing.status, 404);
  const invalid = await fetch(`${baseUrl}/forecast/corpus/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetSymbol: "NVDA" }) });
  assert.equal(invalid.status, 400);
});

test("full-corpus backtests persist provenance, features and news without raw-post sampling", async () => {
  const daily = [{ sessionDate: "2025-01-10", sentimentScore: 0.5, postVolume: 1, engagement: 0 }];
  fake.artifacts.set(historicalCorporaTable, [{
    id: CORPUS_ID, archiveObject: "gs://fixture/archive.zip",
    manifest: { id: CORPUS_ID, title: "Fixture corpus", sourceUrl: "https://www.kaggle.com/datasets/fixture", license: "CC0-1.0", sha256: "fixture-sha", preparedAt: "2025-01-11T00:00:00Z", startDate: "2025-01-10T08:00:00Z", endDate: "2025-01-10T08:00:00Z", sourceRows: 1, uniqueUsablePosts: 1, duplicatesRemoved: 0, invalidRowsRemoved: 0, sampling: "none", method: "Unweighted VADER", limitations: ["Fixture limitation"], assets: { TSLA: { postCount: 1, daily } } },
  }]);
  const catalog = await (await fetch(`${baseUrl}/forecast/corpus`)).json();
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.assets, [{ assetSymbol: "TSLA", postCount: 1, sessionCount: 1 }]);
  const response = await fetch(`${baseUrl}/forecast/corpus/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetSymbol: "TSLA", costAssumptions: { slippageBps: 7 } }) });
  const completed = await response.json();
  assert.equal(response.status, 201, JSON.stringify(completed));
  assert.equal(completed.actorId, "historical-kaggle-corpus");
  assert.equal(completed.status, "completed");
  assert.deepEqual(corpusModelPayload?.posts, []);
  assert.deepEqual(corpusModelPayload?.dailySentiment, daily);
  assert.equal(fake.storedRun?.costAssumptions.slippageBps, 7);
  assert.equal(fake.storedRun?.modelOutput.provenance.sampling, "none");
  assert.equal(fake.storedRun?.modelOutput.historicalAsOf, "2025-01-10");
  const dashboard = await (await fetch(`${baseUrl}/forecast/dashboard?asset=TSLA&runId=${completed.id}`)).json();
  assert.equal(dashboard.historicalAsOf, "2025-01-10");
  assert.equal(dashboard.sourceLicense, "CC0-1.0");
  const report = await (await fetch(`${baseUrl}/forecast/report?runId=${completed.id}`)).json();
  assert.ok(report.markdown.includes("fixture-sha"));
  assert.ok(report.markdown.includes("these are not current forecasts"));
});

test("corpus training failures are saved as failed runs", async () => {
  corpusModelError = true;
  const response = await fetch(`${baseUrl}/forecast/corpus/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetSymbol: "TSLA" }) });
  assert.equal(response.status, 422);
  assert.equal(fake.storedRun?.status, "failed");
  assert.equal(fake.storedRun?.error, "Fixture corpus training failure");
  corpusModelError = false;
});

test("foreign CSV imports retain their calendar through training, dashboard and report", async () => {
  const market = { calendar: "XTSE", timeZone: "America/Toronto", exchange: ".TO", source: "ticker" };
  const foreignOutput = {
    ...modelOutput, assetSymbol: "RY.TO", marketCalendar: "XTSE",
    marketTimezone: "America/Toronto", marketExchange: ".TO", marketCalendarSource: "ticker",
  };
  retryModelOutput = foreignOutput;
  try {
    const response = await fetch(`${baseUrl}/forecast/import`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validImportBody(), assetSymbol: "RY.TO" }),
    });
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.deepEqual(fake.storedRun?.marketMetadata, market);
    assert.deepEqual(lastForecastPayload?.marketMetadata, market);
    const dashboardResponse = await fetch(`${baseUrl}/forecast/dashboard?asset=RY.TO&runId=${saved.id}`);
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.marketCalendar, "XTSE");
    assert.equal(dashboard.marketTimezone, "America/Toronto");
    assert.equal(dashboard.marketCalendarSource, "ticker");
    const reportResponse = await fetch(`${baseUrl}/forecast/report?runId=${saved.id}`);
    assert.equal(reportResponse.status, 200);
    assert.match((await reportResponse.json()).markdown, /Alignment calendar: XTSE; timezone: America\/Toronto/);
  } finally { retryModelOutput = undefined; }

  const before = fake.insertCount;
  const unsupported = await fetch(`${baseUrl}/forecast/import`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...validImportBody(), assetSymbol: "RELIANCE.NS" }),
  });
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error, /No supported exchange calendar/);
  assert.equal(fake.insertCount, before);
});

test("explicit CSV calendar selection is persisted and passed to the model", async () => {
  const response = await fetch(`${baseUrl}/forecast/import`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...validImportBody(), assetSymbol: "RY", marketCalendar: "XTSE" }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(lastForecastPayload?.marketMetadata, {
    calendar: "XTSE", timeZone: "America/Toronto", exchange: "CSV user selection", source: "user",
  });
  assert.equal(fake.storedRun?.marketMetadata.source, "user");
  const invalid = await fetch(`${baseUrl}/forecast/import`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...validImportBody(), marketCalendar: "UNKNOWN" }),
  });
  assert.equal(invalid.status, 400);
});
