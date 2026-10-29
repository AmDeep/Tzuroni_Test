import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { StoredPost, StoredPriceBar, ForecastCostAssumptions, CorpusDailySentiment, StoredMarketMetadata } from "@workspace/db";
import marketCalendars from "../../../crowdwisdom-forecast/python/market-calendars.json";


export type ModelPayload = {
  assetSymbol: string;
  posts: StoredPost[];
  priceBars: StoredPriceBar[];
  costAssumptions?: Partial<ForecastCostAssumptions>;
  dailySentiment?: CorpusDailySentiment[];
  marketMetadata?: StoredMarketMetadata;
  requestedWindow?: { start: string; end: string; maxPosts: number };
};

export type ExchangeMetadata = {
  exchangeName?: string;
  exchangeTimezoneName?: string;
  instrumentType?: string;
};

export function resolveExchangeMetadata(assetSymbol: string, metadata?: ExchangeMetadata, calendarOverride?: string): StoredMarketMetadata {
  if (calendarOverride) {
    const selected = marketCalendars[calendarOverride as keyof typeof marketCalendars];
    if (!selected) throw new Error(`Unsupported calendar: ${calendarOverride}`);
    return { calendar: calendarOverride, timeZone: selected.timeZone, exchange: "CSV user selection", source: "user" };
  }
  const symbol = assetSymbol.trim().toUpperCase();
  const exchange = metadata?.exchangeName?.toUpperCase();
  const entries = Object.entries(marketCalendars);
  const crypto = /(?:[-/](?:USD|USDT|USDC|BUSD))$/.test(symbol) ||
    ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LTC"].includes(symbol);
  const providerMatch = entries.find(([, item]) => (item.exchanges as readonly string[]).includes(exchange ?? ""));
  if (providerMatch) {
    const [calendar, item] = providerMatch;
    if (metadata?.exchangeTimezoneName && metadata.exchangeTimezoneName !== item.timeZone) {
      throw new Error(`Exchange timezone ${metadata.exchangeTimezoneName} conflicts with supported ${calendar} (${item.timeZone}).`);
    }
    return { calendar, timeZone: item.timeZone, exchange: exchange!, source: "provider" };
  }
  // Explicit but unrecognized metadata must never silently use New York sessions.
  if (exchange || metadata?.exchangeTimezoneName || metadata?.instrumentType) {
    if (metadata?.instrumentType === "CRYPTOCURRENCY" && (!metadata.exchangeTimezoneName || metadata.exchangeTimezoneName === "UTC")) {
      return { calendar: "UTC-24/7", timeZone: "UTC", exchange: exchange ?? "CRYPTO", source: "provider" };
    }
    throw new Error(`Unsupported exchange metadata for ${symbol}: ${exchange ?? metadata?.exchangeTimezoneName ?? metadata?.instrumentType}. No U.S. calendar was substituted.`);
  }
  if (crypto) return { calendar: "UTC-24/7", timeZone: "UTC", exchange: "CRYPTO", source: "ticker" };
  const suffix = entries.find(([, item]) => item.suffixes.some((suffix) => symbol.endsWith(suffix)));
  if (suffix) return { calendar: suffix[0], timeZone: suffix[1].timeZone, exchange: symbol.slice(symbol.lastIndexOf(".")), source: "ticker" };
  // Share-class suffixes such as BRK.B are U.S. conventions; other unknown
  // suffixes, futures and FX need explicit support rather than a false calendar.
  if (/[=^]/.test(symbol) || (symbol.includes(".") && !/^[A-Z0-9]+\.[AB]$/.test(symbol))) {
    throw new Error(`No supported exchange calendar for ${symbol}. Supported listings: U.S., .TO, .L, .DE, .PA, .AX, .HK and .T; recognized crypto pairs use UTC.`);
  }
  return { calendar: "XNYS", timeZone: "America/New_York", exchange: "U.S. ticker convention", source: "ticker" };
}

export function buildAssetSearchTerms(asset: string, query?: string, company?: string): string[] {
  const ticker = asset.replace(/[-=].*$/, "").replace(/^[.^]/, "");
  const keyword = company?.trim() || `${ticker} ${asset.endsWith("-USD") ? "cryptocurrency" : "stock"}`;
  return [...new Set([ticker, `$${ticker}`, keyword, query?.trim()].filter((term): term is string => Boolean(term)))];
}

export function buildWindowedSearchTerms(terms: string[], start: Date, end: Date): string[] {
  // Oldest-first weekly queries prevent a single newest-first query from
  // intentionally limiting coverage to the most recent few days.
  const queries: string[] = [];
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += 7 * 86_400_000) {
    const since = new Date(cursor).toISOString().slice(0, 10);
    const until = new Date(Math.min(cursor + 7 * 86_400_000, end.getTime())).toISOString().slice(0, 10);
    queries.push(`(${terms.join(" OR ")}) since:${since} until:${until}`);
  }
  return queries;
}

export type ModelResult = Record<string, unknown> & {
  assetSymbol: string;
  status: "ready";
  hasData: true;
  lastUpdated: string;
  currentPrice: number;
  sentimentScore: number;
  sentimentLabel: string;
  postCount: number;
  priceCount: number;
  series: Array<Record<string, unknown>>;
  forecast: Array<Record<string, unknown>>;
  metrics: Array<Record<string, unknown>>;
  summary: string;
};

function projectRoot(): string {
  const candidates = [
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), ".."),
  ];
  const root = candidates.find((candidate) =>
    existsSync(path.join(candidate, "artifacts/crowdwisdom-forecast/python/forecast.py")),
  );
  if (!root) {
    throw new Error("Could not locate the forecasting model script.");
  }
  return root;
}

export async function runForecastModel(payload: ModelPayload): Promise<ModelResult> {
  const root = projectRoot();
  const scriptPath = path.join(root, "artifacts/crowdwisdom-forecast/python/forecast.py");
  const bundledPython = path.join(root, ".pythonlibs/bin/python");
  const command = process.env.PYTHON_BIN || (existsSync(bundledPython) ? bundledPython : "python3");

  return await new Promise<ModelResult>((resolve, reject) => {
    const child = spawn(command, [scriptPath], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Forecast training exceeded its 3-minute time limit."));
    }, 180_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 10_000_000) {
        child.kill("SIGTERM");
        reject(new Error("Forecast output exceeded the expected size."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Forecast process exited with status ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ModelResult);
      } catch {
        reject(new Error("The forecasting model returned invalid JSON."));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function fetchMarketBars(
  assetSymbol: string,
  lookbackDays: number,
  onName?: (name: string | undefined) => void,
  period?: { start: string; end: string },
  onMarket?: (metadata: StoredMarketMetadata) => void,
): Promise<StoredPriceBar[]> {
  const end = period ? Math.floor(Date.parse(period.end) / 1000) : Math.floor(Date.now() / 1000);
  const start = period ? Math.floor(Date.parse(period.start) / 1000) : end - lookbackDays * 86_400;
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(assetSymbol)}`,
  );
  url.searchParams.set("period1", String(start));
  url.searchParams.set("period2", String(end));
  url.searchParams.set("interval", "1d");
  const response = await fetch(url, {
    headers: { "User-Agent": "CrowdWisdomForecastLab/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Price provider returned HTTP ${response.status}.`);
  }
  const json = (await response.json()) as {
    chart?: {
      error?: { description?: string } | null;
      result?: Array<{
        meta?: ExchangeMetadata & { longName?: string; shortName?: string };
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }> | null;
    };
  };
  const result = json.chart?.result?.[0];
  onName?.(result?.meta?.longName ?? result?.meta?.shortName);
  if (!result?.timestamp?.length) {
    throw new Error(json.chart?.error?.description || `No daily price bars found for ${assetSymbol}.`);
  }
  const market = resolveExchangeMetadata(assetSymbol, result.meta);
  onMarket?.(market);
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  return result.timestamp.flatMap((epoch, index) => {
    const close = closes[index];
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) return [];
    return [{ timestamp: new Date(epoch * 1000).toISOString(), close }];
  });
}

export async function apifyRequest<T>(
  route: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!process.env.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN is not configured.");
  const options = {
    method: init.method ?? "GET",
    ...(init.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(init.body),
        }),
  };
  const response = await fetch(`https://api.apify.com${route}`, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      });
  if (!response.ok) {
    throw new Error(`Apify returned HTTP ${response.status}. Check actor access, account credits, and credentials.`);
  }
  return (await response.json()) as T;
}

export function normalizeApifyPosts(items: unknown[], maxPosts: number): StoredPost[] {
  const seen = new Set<string>();
  const posts: StoredPost[] = [];
  const pickNumber = (...values: unknown[]): number => {
    for (const value of values) {
      const parsed = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
    }
    return 0;
  };
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const author =
      item.author && typeof item.author === "object"
        ? (item.author as Record<string, unknown>)
        : item.user && typeof item.user === "object"
          ? (item.user as Record<string, unknown>)
          : {};
    const timestamp = [
      item.createdAt,
      item.created_at,
      item.timestamp,
      item.date,
      item.time,
    ].find((value) => typeof value === "string");
    const text = [item.fullText, item.full_text, item.text, item.content].find(
      (value) => typeof value === "string",
    );
    if (typeof timestamp !== "string" || typeof text !== "string" || !text.trim()) continue;
    const parsedDate = new Date(timestamp);
    if (Number.isNaN(parsedDate.getTime())) continue;
    const normalizedTimestamp = parsedDate.toISOString();
    const identity = `${normalizedTimestamp}\u0000${text.trim()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    posts.push({
      timestamp: normalizedTimestamp,
      text: text.trim().slice(0, 5000),
      likes: pickNumber(item.likeCount, item.likes, item.favorite_count),
      reposts: pickNumber(item.retweetCount, item.reposts, item.retweet_count),
      views: pickNumber(item.viewCount, item.views),
      authorFollowers: pickNumber(
        author.followers,
        author.followersCount,
        author.followers_count,
      ),
      sentimentLabel:
        typeof item.sentimentLabel === "string" ? item.sentimentLabel : null,
    });
    if (posts.length >= maxPosts) break;
  }
  return posts;
}
