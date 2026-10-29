import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { db, pool, researchRunsTable as runs, researchDailyFeaturesTable as daily, researchRunNewsTable as news } from "@workspace/db";
import { createResearchWorker } from "../src/lib/research-worker";
import { createResearchWorkStore, type ResearchWorkStore, type WorkRun } from "../src/lib/research-work-store";
import type { ModelResult } from "../src/lib/forecasting";

const log = { info() {}, error() {} };
const post = {
  timestamp: "2025-01-10T15:00:00Z", text: "AAPL growing",
  likes: 1, reposts: 0, views: 0, authorFollowers: 0, sentimentLabel: null,
};
const output: ModelResult = {
  assetSymbol: "WORKERTEST", status: "ready", hasData: true, lastUpdated: "2025-01-10T21:00:00Z",
  currentPrice: 100, sentimentScore: 0.5, sentimentLabel: "positive", postCount: 1, priceCount: 1,
  series: [], forecast: [], metrics: [], summary: "Worker fixture",
  alignedDailyData: [{
    sessionDate: "2025-01-10", timestamp: "2025-01-10T21:00:00Z", close: 100,
    sentimentScore: 0.5, postVolume: 1, engagement: 1, return1d: null,
  }],
};
const collectNews = async () => ({ articles: [], providerErrors: { tavily: "Fixture outage" } });
const request = async <T>(path: string): Promise<T> => (
  path.includes("/datasets/") ? [post] : { data: { status: "SUCCEEDED", defaultDatasetId: "fixture" } }
) as T;

function memoryStore(patch: Partial<WorkRun> = {}) {
  let clock = 0;
  let completions = 0;
  let trainingClaims = 0;
  let renewals = 0;
  const row = {
    id: randomUUID(), assetSymbol: "WORKERTEST", status: "scraping", actorRunId: "fixture",
    workerToken: null, workerLeaseUntil: null, workerRetryAt: null, workerFailures: 0,
    rawPosts: [], priceBars: [{ timestamp: "2025-01-10", close: 100 }],
    startedAt: new Date("2025-01-11T00:00:00Z"), lookbackDays: 180, maxPosts: 1000,
    postCount: 0, modelOutput: null, ...patch,
  } as WorkRun;
  const owned = (token: string) => row.workerToken === token && (row.workerLeaseUntil?.getTime() ?? 0) > clock;
  const active = () => ["queued", "scraping", "training"].includes(row.status);
  const store: ResearchWorkStore = {
    async candidates() { return active() && (row.workerRetryAt?.getTime() ?? 0) <= clock ? [{ id: row.id }] : []; },
    async claim(_id, token) {
      if (!active() || (row.workerLeaseUntil?.getTime() ?? 0) > clock) return undefined;
      row.workerToken = token;
      row.workerLeaseUntil = new Date(clock + 1000);
      return structuredClone(row);
    },
    async renew(_id, token) {
      if (!owned(token)) return false;
      renewals++;
      row.workerLeaseUntil = new Date(clock + 1000);
      return true;
    },
    async training(_id, token) {
      if (!owned(token) || row.status !== "scraping") return undefined;
      trainingClaims++;
      row.status = "training";
      return structuredClone(row);
    },
    async checkpoint(_id, token, updates) {
      if (!owned(token)) return undefined;
      Object.assign(row, updates);
      return structuredClone(row);
    },
    async defer(_id, token, ms, failures, error) {
      if (!owned(token)) return;
      Object.assign(row, { workerToken: null, workerLeaseUntil: null, workerRetryAt: new Date(clock + ms), workerFailures: failures, workerLastError: error });
    },
    async fail(_id, token, error) {
      if (!owned(token)) return;
      Object.assign(row, { workerToken: null, workerLeaseUntil: null, status: "failed", error });
    },
    async complete(_id, token, result, posts) {
      if (!owned(token)) return false;
      completions++;
      Object.assign(row, { workerToken: null, workerLeaseUntil: null, status: "completed", modelOutput: result, rawPosts: posts, postCount: posts.length });
      return true;
    },
  };
  return {
    store, row, advance(ms: number) { clock += ms; },
    get completions() { return completions; }, get trainingClaims() { return trainingClaims; },
    get renewals() { return renewals; },
  };
}

test("background tick finishes a collection without a browser polling endpoint", async () => {
  const state = memoryStore();
  let models = 0;
  const stop = createResearchWorker({
    store: state.store, log, request, collectNews,
    model: async () => { models++; return output; },
  }).start();
  try {
    for (let i = 0; i < 100 && state.row.status !== "completed"; i++) await delay(5);
  } finally { await stop(); }
  assert.equal(state.row.status, "completed");
  assert.equal(state.row.postCount, 1);
  assert.equal(models, 1);
  assert.equal(state.trainingClaims, 1);
  assert.equal(state.completions, 1);
});

test("graceful shutdown waits for owned work and stops claiming more", async () => {
  const state = memoryStore({ status: "training", rawPosts: [post] });
  let release!: () => void;
  let started!: () => void;
  let stopped = false;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = createResearchWorker({
    store: state.store, log, request, collectNews,
    model: async () => { started(); await gate; return output; },
  });
  const stop = worker.start();
  await startedPromise;
  const stopping = stop().then(() => { stopped = true; });
  await delay(5);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(state.row.status, "completed");
  await worker.tick();
  assert.equal(state.completions, 1);
});

test("a restarted worker resumes interrupted training from persisted posts", async () => {
  const state = memoryStore({ status: "training", rawPosts: [post], workerToken: "dead-process", workerLeaseUntil: new Date(-1) });
  let models = 0;
  await createResearchWorker({
    store: state.store, log, collectNews,
    request: async () => { throw new Error("Persisted posts must not be scraped again"); },
    model: async () => { models++; return output; },
  }).tick();
  assert.equal(models, 1);
  assert.equal(state.row.status, "completed");
});

test("restart after model checkpoint persists artifacts without retraining", async () => {
  const state = memoryStore({ status: "training", rawPosts: [post], modelOutput: output, workerToken: "dead", workerLeaseUntil: new Date(-1) });
  await createResearchWorker({
    store: state.store, log, collectNews,
    request: async () => { throw new Error("No collection required"); },
    model: async () => { throw new Error("No retraining required"); },
  }).tick();
  assert.equal(state.row.status, "completed");
  assert.equal(state.completions, 1);
});

test("background training uses persisted provider calendar rather than guessing from the ticker", async () => {
  const marketMetadata = { calendar: "XTSE", timeZone: "America/Toronto", exchange: "TOR", source: "provider" as const };
  const state = memoryStore({ assetSymbol: "GLOBAL", marketMetadata });
  await createResearchWorker({
    store: state.store, log, request, collectNews,
    model: async (payload) => {
      assert.deepEqual(payload.marketMetadata, marketMetadata);
      return { ...output, marketCalendar: "XTSE" };
    },
  }).tick();
  assert.equal(state.row.modelOutput?.marketCalendar, "XTSE");
  assert.equal(state.row.status, "completed");
});

test("an interrupted foreign model checkpoint using the old U.S. calendar is retrained", async () => {
  const state = memoryStore({
    assetSymbol: "RY.TO", status: "training", rawPosts: [post],
    modelOutput: { ...output, marketCalendar: "XNYS" },
  });
  let models = 0;
  await createResearchWorker({
    store: state.store, log, request, collectNews,
    model: async (payload) => {
      models++;
      assert.equal(payload.marketMetadata?.calendar, "XTSE");
      return { ...output, marketCalendar: "XTSE" };
    },
  }).tick();
  assert.equal(models, 1);
  assert.equal(state.row.modelOutput?.marketCalendar, "XTSE");
  assert.equal(state.row.status, "completed");
});

test("competing workers claim training and completion only once", async () => {
  const state = memoryStore();
  let models = 0;
  const options = { store: state.store, log, request, collectNews, model: async () => { models++; await delay(15); return output; } };
  await Promise.all([createResearchWorker(options).tick(), createResearchWorker(options).tick()]);
  assert.equal(models, 1);
  assert.equal(state.trainingClaims, 1);
  assert.equal(state.completions, 1);
});

test("expired ownership fences a late model from replacing the new worker's result", async () => {
  const state = memoryStore({ status: "training", rawPosts: [post] });
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const old = createResearchWorker({
    store: state.store, log, request, collectNews,
    model: async () => { started(); await gate; return output; },
  }).tick();
  await startedPromise;
  state.advance(2000);
  const newer = { ...output, currentPrice: 200 };
  await createResearchWorker({ store: state.store, log, request, collectNews, model: async () => newer }).tick();
  release();
  await old;
  assert.equal(state.row.modelOutput?.currentPrice, 200);
  assert.equal(state.completions, 1);
});

test("transient Apify failures persist a backoff and recover on a later worker", async () => {
  const state = memoryStore();
  await createResearchWorker({ store: state.store, log, collectNews, request: async () => { throw new Error("Temporary provider outage"); } }).tick();
  assert.equal(state.row.status, "scraping");
  assert.equal(state.row.workerFailures, 1);
  assert.match(state.row.workerLastError!, /Temporary provider outage/);
  const restarted = createResearchWorker({ store: state.store, log, request, collectNews, model: async () => output });
  await restarted.tick();
  assert.equal(state.row.status, "scraping");
  state.advance(5000);
  await restarted.tick();
  assert.equal(state.row.status, "completed");
});

test("heartbeat renews ownership during a slow training call", async () => {
  const state = memoryStore();
  await createResearchWorker({
    store: state.store, log, request, collectNews, heartbeatMs: 5,
    model: async () => { await delay(25); return output; },
  }).tick();
  assert.ok(state.renewals > 0);
  assert.equal(state.row.status, "completed");
});

test("a hung provider backs off instead of holding the worker forever", async () => {
  const state = memoryStore();
  await createResearchWorker({
    store: state.store, log, collectNews, operationTimeoutMs: 10,
    request: () => new Promise(() => {}),
  }).tick();
  assert.equal(state.row.status, "scraping");
  assert.equal(state.row.workerToken, null);
  assert.match(state.row.workerLastError!, /timed out/);
});

test("a hung news provider is recorded without losing a trained forecast", async () => {
  const state = memoryStore();
  let errors: unknown;
  const complete = state.store.complete;
  state.store.complete = async (...args) => { errors = args[4].providerErrors; return complete(...args); };
  await createResearchWorker({
    store: state.store, log, request, model: async () => output, operationTimeoutMs: 10,
    collectNews: () => new Promise(() => {}),
  }).tick();
  assert.equal(state.row.status, "completed");
  assert.deepEqual(errors, { tavily: "News collection timed out.", exa: "News collection timed out." });
});

test("terminal collection and model errors fail explicitly; stale setup never starts a duplicate actor", async () => {
  for (const scenario of ["actor", "empty", "model", "queued", "exhausted"]) {
    const state = memoryStore({
      ...(scenario === "queued" ? { status: "queued", actorRunId: null } : {}),
      ...(scenario === "exhausted" ? { workerFailures: 4 } : {}),
    });
    await createResearchWorker({
      store: state.store, log, collectNews,
      request: async <T>(path: string): Promise<T> => {
        if (scenario === "queued") assert.fail("Interrupted setup must not launch a paid actor");
        if (scenario === "exhausted") throw new Error("Provider unavailable");
        if (scenario === "actor") return { data: { status: "FAILED", statusMessage: "Actor failed" } } as T;
        if (scenario === "empty" && path.includes("/datasets/")) return [] as T;
        return request<T>(path);
      },
      model: async () => { throw new Error("Insufficient observations"); },
    }).tick();
    assert.equal(state.row.status, "failed", scenario);
    assert.ok(state.row.error, scenario);
    assert.equal(state.completions, 0);
  }
});

test("PostgreSQL leases, restart recovery, fencing and artifact rollback", {
  skip: process.env.RUN_WORKER_DB_TESTS !== "1",
}, async () => {
  const ids: string[] = [];
  async function seed(patch: Partial<typeof runs.$inferInsert> = {}) {
    const [row] = await db.insert(runs).values({
      assetSymbol: "WORKERTEST", actorId: "worker-regression-fixture", actorRunId: "fixture",
      searchQuery: "fixture", lookbackDays: 180, maxPosts: 20, status: "scraping",
      startedAt: new Date("2025-01-11T00:00:00Z"),
      priceBars: [{ timestamp: "2025-01-10", close: 100 }], ...patch,
    }).returning();
    ids.push(row.id);
    return row;
  }
  function isolatedStore(id: string) {
    const store = createResearchWorkStore();
    return { ...store, candidates: async () => [{ id }] };
  }
  try {
    const run = await seed();
    const store = isolatedStore(run.id);
    let models = 0;
    const options = {
      store, log, request, collectNews,
      model: async () => { models++; await delay(15); return output; },
    };
    await Promise.all([createResearchWorker(options).tick(), createResearchWorker(options).tick()]);
    assert.equal(models, 1);
    const [saved] = await db.select().from(runs).where(eq(runs.id, run.id));
    assert.equal(saved.status, "completed");
    assert.equal((await db.select().from(daily).where(eq(daily.runId, run.id))).length, 1);
    assert.equal((await db.select().from(news).where(eq(news.runId, run.id))).length, 1);

    const interrupted = await seed({
      status: "training", rawPosts: [post], modelOutput: output,
      workerToken: "dead-process", workerLeaseUntil: new Date(0),
    });
    await createResearchWorker({
      store: isolatedStore(interrupted.id), log, collectNews,
      request: async () => { throw new Error("No actor restart"); },
      model: async () => { throw new Error("No retraining after checkpoint"); },
    }).tick();
    assert.equal((await db.select().from(runs).where(eq(runs.id, interrupted.id)))[0].status, "completed");
    assert.equal((await db.select().from(daily).where(eq(daily.runId, interrupted.id))).length, 1);

    const fenced = await seed({ status: "training", rawPosts: [post] });
    const fencedStore = isolatedStore(fenced.id);
    assert.ok(await fencedStore.claim(fenced.id, "old"));
    await db.update(runs).set({ workerLeaseUntil: new Date(0) }).where(eq(runs.id, fenced.id));
    assert.ok(await fencedStore.claim(fenced.id, "new"));
    assert.equal(await fencedStore.renew(fenced.id, "old"), false);
    assert.equal(await fencedStore.complete(fenced.id, "old", output, [post], await collectNews()), false);
    await fencedStore.fail(fenced.id, "old", "stale failure");
    assert.equal((await db.select().from(runs).where(eq(runs.id, fenced.id)))[0].status, "training");
    const broken = { ...output, alignedDailyData: [...(output.alignedDailyData as object[]), ...(output.alignedDailyData as object[])] };
    await assert.rejects(fencedStore.complete(fenced.id, "new", broken, [post], await collectNews()));
    assert.equal((await db.select().from(daily).where(eq(daily.runId, fenced.id))).length, 0);
    assert.equal((await db.select().from(news).where(eq(news.runId, fenced.id))).length, 0);
    assert.equal((await db.select().from(runs).where(eq(runs.id, fenced.id)))[0].status, "training");
    assert.equal(await fencedStore.complete(fenced.id, "new", output, [post], await collectNews()), true);
    assert.equal((await db.select().from(daily).where(eq(daily.runId, fenced.id))).length, 1);
    assert.equal((await db.select().from(news).where(eq(news.runId, fenced.id))).length, 1);
  } finally {
    for (const id of ids) await db.delete(runs).where(eq(runs.id, id));
  }
});

after(async () => { await pool.end(); });
