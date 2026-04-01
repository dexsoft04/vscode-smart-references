/**
 * Run async tasks with a concurrency cap.
 * Fires at most `limit` tasks simultaneously.
 */
export async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const iter = items[Symbol.iterator]();
  async function worker(): Promise<void> {
    for (let next = iter.next(); !next.done; next = iter.next()) {
      await fn(next.value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}
