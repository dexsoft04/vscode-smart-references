export const DEFAULT_TEXT_SEARCH_HISTORY_LIMIT = 20;
export const MIN_TEXT_SEARCH_HISTORY_LIMIT = 1;
export const MAX_TEXT_SEARCH_HISTORY_LIMIT = 100;

export function normalizeTextSearchHistoryLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TEXT_SEARCH_HISTORY_LIMIT;
  const normalized = Math.floor(value);
  if (normalized < MIN_TEXT_SEARCH_HISTORY_LIMIT) return MIN_TEXT_SEARCH_HISTORY_LIMIT;
  if (normalized > MAX_TEXT_SEARCH_HISTORY_LIMIT) return MAX_TEXT_SEARCH_HISTORY_LIMIT;
  return normalized;
}

export function sanitizeTextSearchHistory(entries: readonly string[] | undefined, limit: number): string[] {
  const normalizedLimit = normalizeTextSearchHistoryLimit(limit);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    if (entry.trim().length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    deduped.push(entry);
    if (deduped.length >= normalizedLimit) break;
  }
  return deduped;
}

export function pushTextSearchHistory(
  entries: readonly string[] | undefined,
  query: string,
  limit: number,
): string[] {
  if (query.trim().length === 0) return sanitizeTextSearchHistory(entries, limit);
  return sanitizeTextSearchHistory(
    [query, ...(entries ?? []).filter(entry => entry !== query)],
    limit,
  );
}
