export type SentimentCoverage = {
  postStartDate: string | null;
  postEndDate: string | null;
  activePostDays: number;
  activePriceDays: number;
  priceWindowDays: number;
  coverageRatio: number;
  isSparse: boolean;
};

function utcDay(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function timestampDays(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) =>
      row && typeof row === "object"
        ? utcDay((row as Record<string, unknown>).timestamp)
        : null,
    )
    .filter((day): day is string => day !== null);
}

export function calculateSentimentCoverage(
  posts: unknown,
  priceBars: unknown,
): SentimentCoverage {
  const postDays = [...new Set(timestampDays(posts))].sort();
  const priceDays = new Set(timestampDays(priceBars));
  const activePriceDays = postDays.filter((day) => priceDays.has(day)).length;
  const priceWindowDays = priceDays.size;
  const coverageRatio = priceWindowDays ? activePriceDays / priceWindowDays : 0;

  return {
    postStartDate: postDays[0] ?? null,
    postEndDate: postDays.at(-1) ?? null,
    activePostDays: postDays.length,
    activePriceDays,
    priceWindowDays,
    coverageRatio,
    isSparse: priceWindowDays > 0 && coverageRatio < 0.2,
  };
}
