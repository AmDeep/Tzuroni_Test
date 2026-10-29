import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  db, researchRunsTable as runs, researchDailyFeaturesTable, researchRunNewsTable,
  type StoredPost,
} from "@workspace/db";
import { persistDailyFeatures, persistNewsSnapshot, type NewsCollector } from "./run-artifacts";
import type { ModelResult } from "./forecasting";

export type WorkRun = typeof runs.$inferSelect;
export type WorkNews = Awaited<ReturnType<NewsCollector>>;
export interface ResearchWorkStore {
  candidates(): Promise<Array<{ id: string }>>;
  claim(id: string, token: string): Promise<WorkRun | undefined>;
  renew(id: string, token: string): Promise<boolean>;
  training(id: string, token: string): Promise<WorkRun | undefined>;
  checkpoint(id: string, token: string, patch: Partial<WorkRun>): Promise<WorkRun | undefined>;
  defer(id: string, token: string, delayMs: number, failures: number, error?: string): Promise<void>;
  fail(id: string, token: string, error: string): Promise<void>;
  complete(id: string, token: string, output: ModelResult, posts: StoredPost[], news: WorkNews): Promise<boolean>;
}

export function createResearchWorkStore(database = db, leaseMs = 120_000): ResearchWorkStore {
  // Use database time, not a worker's clock, for all lease/fencing decisions.
  const now = sql`clock_timestamp()`;
  const after = (ms: number) => sql`clock_timestamp() + ${ms} * interval '1 millisecond'`;
  const available = () => and(
    or(isNull(runs.workerLeaseUntil), lte(runs.workerLeaseUntil, now)),
    or(isNull(runs.workerRetryAt), lte(runs.workerRetryAt, now)),
    or(
      and(inArray(runs.status, ["scraping", "training"]), isNotNull(runs.actorRunId)),
      // Do not launch a second paid actor when setup died before its ID was saved.
      and(eq(runs.status, "queued"), lt(runs.startedAt, after(-600_000))),
    ),
  );
  const owned = (id: string, token: string) => and(
    eq(runs.id, id), eq(runs.workerToken, token),
    sql`${runs.workerLeaseUntil} > clock_timestamp()`,
    inArray(runs.status, ["queued", "scraping", "training"]),
  );
  const released = { workerToken: null, workerLeaseUntil: null };
  return {
    candidates: () => database.select({ id: runs.id }).from(runs)
      .where(available()).orderBy(runs.startedAt).limit(20),
    async claim(id, token) {
      const [row] = await database.update(runs)
        .set({ workerToken: token, workerLeaseUntil: after(leaseMs) })
        .where(and(eq(runs.id, id), available())).returning();
      return row;
    },
    async renew(id, token) {
      const rows = await database.update(runs).set({ workerLeaseUntil: after(leaseMs) })
        .where(owned(id, token)).returning({ id: runs.id });
      return rows.length === 1;
    },
    async training(id, token) {
      const [row] = await database.update(runs).set({
        status: "training", error: null, workerFailures: 0, workerLastError: null,
      })
        .where(and(owned(id, token), eq(runs.status, "scraping"))).returning();
      return row;
    },
    async checkpoint(id, token, patch) {
      const [row] = await database.update(runs).set({
        ...patch, workerFailures: 0, workerLastError: null,
      }).where(owned(id, token)).returning();
      return row;
    },
    async defer(id, token, delayMs, failures, error) {
      await database.update(runs).set({
        ...released, workerRetryAt: after(delayMs), workerFailures: failures,
        workerLastError: error ?? null,
      }).where(owned(id, token));
    },
    async fail(id, token, error) {
      await database.update(runs).set({
        ...released, workerRetryAt: null, status: "failed",
        finishedAt: now, error, workerLastError: error,
      }).where(owned(id, token));
    },
    async complete(id, token, output, posts, news) {
      return database.transaction(async (tx) => {
        // The fenced UPDATE holds a row lock until all artifacts and status commit.
        // Expired/stale workers cannot publish, even if their model finishes late.
        const rows = await tx.update(runs).set({ workerLeaseUntil: after(leaseMs) })
          .where(and(owned(id, token), eq(runs.status, "training")))
          .returning({ assetSymbol: runs.assetSymbol });
        if (!rows.length) return false;
        await tx.delete(researchDailyFeaturesTable).where(eq(researchDailyFeaturesTable.runId, id));
        await tx.delete(researchRunNewsTable).where(eq(researchRunNewsTable.runId, id));
        const artifactDb = tx as unknown as typeof db;
        await persistDailyFeatures(artifactDb, id, rows[0].assetSymbol, output);
        await persistNewsSnapshot(artifactDb, id, rows[0].assetSymbol, async () => news);
        await tx.update(runs).set({
          ...released, workerRetryAt: null, workerFailures: 0, workerLastError: null,
          rawPosts: posts, postCount: posts.length, modelOutput: output,
          status: "completed", finishedAt: now, error: null,
        }).where(and(eq(runs.id, id), eq(runs.workerToken, token)));
        return true;
      });
    },
  };
}
