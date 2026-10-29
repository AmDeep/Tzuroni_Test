import { randomUUID } from "node:crypto";
import { apifyRequest, normalizeApifyPosts, runForecastModel, resolveExchangeMetadata } from "./forecasting";
import type { ResearchWorkStore, WorkNews } from "./research-work-store";

type WorkerLog = {
  info: (obj: object, message: string) => void;
  error: (obj: object, message: string) => void;
};
type ActorResult = { data?: { status?: string; statusMessage?: string; defaultDatasetId?: string } };
class PermanentWorkError extends Error {}

export function createResearchWorker(options: {
  store: ResearchWorkStore;
  log: WorkerLog;
  collectNews: (asset: string) => Promise<WorkNews>;
  request?: typeof apifyRequest;
  model?: typeof runForecastModel;
  heartbeatMs?: number;
  intervalMs?: number;
  operationTimeoutMs?: number;
}) {
  const { store, log, collectNews } = options;
  const request = options.request ?? apifyRequest;
  const model = options.model ?? runForecastModel;
  let stopping = false;
  let active: Promise<void> | undefined;

  async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out.`)), options.operationTimeoutMs ?? 45_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function processRun(id: string) {
    const token = randomUUID();
    let row = await store.claim(id, token);
    if (!row) return;
    let lost = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      void store.renew(id, token).then((owned) => { if (!owned) lost = true; })
        .catch((error) => {
          lost = true;
          log.error({ runId: id, error: String(error) }, "Research worker lost lease renewal");
        }).finally(() => { renewing = false; });
    }, options.heartbeatMs ?? 30_000);
    heartbeat.unref();
    try {
      if (row.status === "queued") {
        throw new PermanentWorkError("Research setup was interrupted before its Apify run ID was saved. Retry this collection; no second actor was launched automatically.");
      }
      let marketMetadata;
      try { marketMetadata = row.marketMetadata ?? resolveExchangeMetadata(row.assetSymbol); }
      catch (error) { throw new PermanentWorkError(error instanceof Error ? error.message : "Unsupported exchange calendar."); }
      let output = row.modelOutput as Awaited<ReturnType<typeof runForecastModel>> | null;
      // A pre-upgrade foreign job may have checkpointed an XNYS model. Resume
      // its posts, not a model trained with the wrong alignment. Completed runs
      // are never selected by this worker and remain immutable.
      const incompatibleCheckpoint = output && (output.marketCalendar ?? "XNYS") !== marketMetadata.calendar;
      if (incompatibleCheckpoint) output = null;
      if (!row.marketMetadata || incompatibleCheckpoint) {
        row = await store.checkpoint(id, token, {
          marketMetadata, ...(incompatibleCheckpoint ? { modelOutput: null } : {}),
        });
        if (!row) return;
      }
      let posts = row.rawPosts;
      if (!output) {
        let dataset: string | undefined;
        if (row.status === "scraping" || !posts.length) {
          const actor = await bounded(request<ActorResult>(`/v2/actor-runs/${encodeURIComponent(row.actorRunId!)}`), "Apify status lookup");
          if (lost) return;
          const state = actor.data?.status;
          if (["READY", "RUNNING", "TIMING-OUT", "ABORTING"].includes(state ?? "")) {
            await store.defer(id, token, 10_000, 0);
            return;
          }
          if (["FAILED", "TIMED-OUT", "ABORTED"].includes(state ?? "")) {
            throw new PermanentWorkError(actor.data?.statusMessage || `Apify run ended with ${state}.`);
          }
          if (state !== "SUCCEEDED") throw new Error(`Unrecognized Apify state: ${state ?? "missing"}.`);
          dataset = actor.data?.defaultDatasetId;
          if (!dataset && !posts.length) throw new PermanentWorkError("Apify completed without a dataset ID.");
        }
        if (row.status === "scraping") {
          row = await store.training(id, token);
          if (!row) return;
        }
        if (!posts.length) {
          const items = await bounded(request<unknown[]>(`/v2/datasets/${encodeURIComponent(dataset!)}/items?format=json&clean=true&limit=${row.maxPosts}`), "Apify dataset download");
          posts = normalizeApifyPosts(items, row.maxPosts);
          const end = row.startedAt.getTime();
          const start = end - row.lookbackDays * 86_400_000;
          posts = posts.filter((post) => {
            const timestamp = Date.parse(post.timestamp);
            return timestamp >= start && timestamp <= end;
          });
          if (!posts.length) throw new PermanentWorkError("The Apify run completed but returned no usable, timestamped posts.");
          if (lost) return;
          row = await store.checkpoint(id, token, { rawPosts: posts, postCount: posts.length });
          if (!row) return;
        }
        try {
          output = await model({
            assetSymbol: row.assetSymbol, posts, priceBars: row.priceBars,
            costAssumptions: row.costAssumptions,
            marketMetadata,
            requestedWindow: {
              start: new Date(row.startedAt.getTime() - row.lookbackDays * 86_400_000).toISOString(),
              end: row.startedAt.toISOString(), maxPosts: row.maxPosts,
            },
          });
          if (output.marketCalendar && output.marketCalendar !== marketMetadata.calendar) {
            throw new PermanentWorkError("Model alignment calendar does not match the resolved exchange.");
          }
        } catch (error) {
          throw new PermanentWorkError(error instanceof Error ? error.message : "Model training failed.");
        }
        if (lost) return;
        row = await store.checkpoint(id, token, { modelOutput: output });
        if (!row) return;
      }
      output = {
        ...output, marketCalendar: marketMetadata.calendar, marketTimezone: marketMetadata.timeZone,
        marketExchange: marketMetadata.exchange, marketCalendarSource: marketMetadata.source,
      };
      let news: WorkNews;
      try {
        news = await bounded(collectNews(row.assetSymbol), "News collection");
      } catch (error) {
        const message = error instanceof Error ? error.message : "News collection failed.";
        news = { articles: [], providerErrors: { tavily: message, exa: message } };
      }
      if (lost) return;
      if (await store.complete(id, token, output, posts, news)) {
        log.info({ runId: id, postCount: posts.length }, "Background research run completed");
      }
    } catch (error) {
      if (lost) return;
      const message = error instanceof Error ? error.message : "Research completion failed.";
      const failures = (row?.workerFailures ?? 0) + 1;
      log.error({ runId: id, error: message, failures }, "Background research completion error");
      if (error instanceof PermanentWorkError || failures >= 5) {
        await store.fail(id, token, failures >= 5 ? `Background completion failed after ${failures} attempts: ${message}` : message);
      } else {
        await store.defer(id, token, Math.min(300_000, 5_000 * 2 ** (failures - 1)), failures, message);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function work() {
    try {
      for (const { id } of await store.candidates()) {
        if (stopping) break;
        try { await processRun(id); }
        catch (error) { log.error({ runId: id, error: String(error) }, "Research worker could not persist progress; lease will expire"); }
      }
    } catch (error) {
      log.error({ error: String(error) }, "Research worker scan failed; will retry");
    }
  }
  function tick() {
    if (stopping) return Promise.resolve();
    if (!active) active = work().finally(() => { active = undefined; });
    return active;
  }
  return {
    tick,
    start() {
      void tick();
      const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 5_000);
      timer.unref();
      return async () => { stopping = true; clearInterval(timer); await active; };
    },
  };
}
