/**
 * Параллельный map с потолком одновременных задач. Сохраняет порядок результатов.
 *
 * Зачем: `Promise.all(items.map(fn))` хорош для двух-трёх запросов, но опасен
 * для горячих путей с десятками items: если каждый item делает SQL/HTTP/PNG-render,
 * мы либо превышаем connection pool, либо создаём CPU-затор. Здесь — N воркеров,
 * каждый берёт следующий индекс из общего курсора.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const cap = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: cap }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}
