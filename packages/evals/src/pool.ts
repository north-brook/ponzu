/** `run` over `items`, at most `concurrency` at once, results in the items' order. */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < items.length && failed === null) {
      const index = next++;
      try {
        results[index] = await run(items[index]!, index);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  if (failed !== null) throw failed;
  return results;
}
