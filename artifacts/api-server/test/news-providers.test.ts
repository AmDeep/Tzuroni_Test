import assert from "node:assert/strict";
import { test } from "node:test";
import { searchAssetNews } from "../src/routes/research";
import { apifyRequest } from "../src/lib/forecasting";
import type { db } from "@workspace/db";

function emptyCache() {
  let writes = 0;
  return {
    database: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { writes++; } }) }),
    } as unknown as typeof db,
    writes: () => writes,
  };
}

test("standalone news calls both providers directly with their own credentials", async () => {
  process.env.TAVILY_API_KEY = "test-tavily-key";
  process.env.EXA_API_KEY = "test-exa-key";
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const cache = emptyCache();
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://api.exa.ai/search") {
      assert.equal((options?.headers as Record<string, string>)["x-api-key"], "test-exa-key");
    } else {
      assert.equal(JSON.parse(String(options?.body)).api_key, "test-tavily-key");
    }
    return Response.json({ results: [{
      title: "Asset news", url: `https://example.org/${calls.length}`,
      publishedDate: "2026-10-29T10:00:00Z",
      published_date: "2026-10-29T10:00:00Z",
    }] });
  };
  try {
    const result = await searchAssetNews(cache.database, "TEST");
    assert.deepEqual(new Set(calls), new Set(["https://api.tavily.com/search", "https://api.exa.ai/search"]));
    assert.deepEqual(result.providerErrors, {});
    assert.equal(result.articles.length, 2);
    assert.equal(cache.writes(), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing standalone Exa access leaves healthy Tavily results visible and uncached", async () => {
  process.env.TAVILY_API_KEY = "test-tavily-key";
  delete process.env.EXA_API_KEY;
  const originalFetch = globalThis.fetch;
  const cache = emptyCache();
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.tavily.com/search");
    return Response.json({ results: [{ title: "News", url: "https://example.org/news" }] });
  };
  try {
    const result = await searchAssetNews(cache.database, "TEST");
    assert.equal(result.articles.length, 1);
    assert.match(result.providerErrors.exa!, /EXA_API_KEY/);
    assert.equal(result.providerErrors.tavily, undefined);
    assert.equal(cache.writes(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("standalone Apify fails explicitly without its token and never launches a request", async () => {
  delete process.env.APIFY_API_TOKEN;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  try {
    await assert.rejects(apifyRequest("/v2/users/me"), /APIFY_API_TOKEN is not configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
