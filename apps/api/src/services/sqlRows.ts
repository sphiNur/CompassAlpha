/**
 * The rows of a raw `db.execute(sql…)` (review RUNAPI-14).
 *
 * postgres-js, the driver here, returns them as an array; node-postgres
 * wraps them in `{ rows }`. The routers read either shape inline, five
 * times over, besides two helpers of their own; this reads both.
 */
export function executeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
