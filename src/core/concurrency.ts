/** Bound independent filesystem work and drain in-flight tasks before reporting failure. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, visit: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try { result[index] = await visit(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
  return result;
}
