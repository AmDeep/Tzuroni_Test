import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchMarketBars, resolveExchangeMetadata, buildWindowedSearchTerms } from "../src/lib/forecasting";

test("dated search terms cover the complete requested window in oldest-first weekly slices", () => {
  const queries = buildWindowedSearchTerms(["TSLA", "$TSLA", "Tesla"], new Date("2025-01-01T00:00Z"), new Date("2025-01-19T00:00Z"));
  assert.equal(queries.length, 3);
  assert.match(queries[0], /\(TSLA OR \$TSLA OR Tesla\) since:2025-01-01 until:2025-01-08/);
  assert.match(queries[2], /since:2025-01-15 until:2025-01-19/);
});

const listings = [
  ["RY.TO", "XTSE", "TOR", "America/Toronto"],
  ["VOD.L", "XLON", "LSE", "Europe/London"],
  ["SAP.DE", "XETR", "GER", "Europe/Berlin"],
  ["AIR.PA", "XPAR", "PAR", "Europe/Paris"],
  ["BHP.AX", "XASX", "ASX", "Australia/Sydney"],
  ["0700.HK", "XHKG", "HKG", "Asia/Hong_Kong"],
  ["7203.T", "XTKS", "JPX", "Asia/Tokyo"],
];

test("foreign listing suffixes and provider exchanges resolve the same calendars", () => {
  for (const [asset, calendar, exchange, timeZone] of listings) {
    assert.deepEqual(resolveExchangeMetadata(asset), {
      calendar, timeZone, exchange: asset.slice(asset.lastIndexOf(".")), source: "ticker",
    });
    assert.deepEqual(resolveExchangeMetadata(asset, { exchangeName: exchange, exchangeTimezoneName: timeZone }), {
      calendar, timeZone, exchange, source: "provider",
    });
  }
  assert.equal(resolveExchangeMetadata("GLOBAL", { exchangeName: "TOR" }).calendar, "XTSE");
  assert.equal(resolveExchangeMetadata("BTC-USD", { exchangeName: "CCC", exchangeTimezoneName: "UTC", instrumentType: "CRYPTOCURRENCY" }).calendar, "UTC-24/7");
  assert.equal(resolveExchangeMetadata("BRK.B").calendar, "XNYS");
});

test("unknown or conflicting exchanges fail explicitly rather than using U.S. sessions", () => {
  for (const asset of ["RELIANCE.NS", "ABC.ZZ", "EURUSD=X", "^GSPC"]) {
    assert.throws(() => resolveExchangeMetadata(asset), /No supported exchange calendar/);
  }
  assert.throws(() => resolveExchangeMetadata("GLOBAL", { exchangeName: "UNKNOWN" }), /No U.S. calendar was substituted/);
  assert.throws(() => resolveExchangeMetadata("RY.TO", { exchangeName: "TOR", exchangeTimezoneName: "America/New_York" }), /conflicts/);
});

test("market-price retrieval carries resolved provider metadata", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    chart: { result: [{
      meta: { longName: "Canadian fixture", exchangeName: "TOR", exchangeTimezoneName: "America/Toronto", instrumentType: "EQUITY" },
      timestamp: [1736519400], indicators: { quote: [{ close: [100] }] },
    }] },
  }), { status: 200 });
  try {
    let resolved;
    const bars = await fetchMarketBars("RY.TO", 180, undefined, undefined, (market) => { resolved = market; });
    assert.equal(bars.length, 1);
    assert.deepEqual(resolved, { calendar: "XTSE", timeZone: "America/Toronto", exchange: "TOR", source: "provider" });
  } finally { globalThis.fetch = previous; }
});

test("price retrieval rejects unsupported provider metadata even without a metadata callback", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    chart: { result: [{ meta: { exchangeName: "UNKNOWN" }, timestamp: [1736519400] }] },
  }), { status: 200 });
  try {
    await assert.rejects(fetchMarketBars("GLOBAL", 180), /No U.S. calendar was substituted/);
  } finally { globalThis.fetch = previous; }
});
