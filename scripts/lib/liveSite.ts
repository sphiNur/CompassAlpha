/**
 * Review OPS-08 (2026-11): wait for the restarted api to answer through
 * the public URL before the smokes start. They used to start two seconds
 * after the restart, and the first realtime probe often failed where a
 * re-run was green.
 */

/** Polls `${base}/health/ready` until it answers 200 or `timeoutMs` has passed. */
export async function waitUntilReady(
  base: string,
  { timeoutMs = 90_000, intervalMs = 3_000, fetchImpl = fetch as typeof fetch } = {},
): Promise<{ ok: true; afterMs: number } | { ok: false; last: string }> {
  const start = Date.now();
  let last = 'no answer yet';
  for (;;) {
    try {
      const res = await fetchImpl(`${base}/health/ready`, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(Math.min(10_000, timeoutMs)),
      });
      if (res.ok) return { ok: true, afterMs: Date.now() - start };
      last = `${res.status} ${(await res.text()).slice(0, 120)}`;
    } catch (err) {
      last = (err as Error).message;
    }
    if (Date.now() - start + intervalMs > timeoutMs) return { ok: false, last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
