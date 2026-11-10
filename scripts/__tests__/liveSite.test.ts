import { describe, expect, test } from 'bun:test';
import { waitUntilReady } from '../lib/liveSite';

/** A site that answers `statuses` in turn (the last one from then on). */
function site(statuses: Array<number | 'down'>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    const s = statuses[Math.min(asked.length - 1, statuses.length - 1)];
    if (s === 'down') throw new TypeError('fetch failed');
    return new Response(s === 200 ? '{"status":"ok"}' : '{"status":"down","component":"db"}', {
      status: s,
    });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe('waiting for the restarted api (OPS-08)', () => {
  test('ready on the third try', async () => {
    const s = site(['down', 503, 200]);
    const r = await waitUntilReady('https://x', { intervalMs: 1, fetchImpl: s.fetchImpl });
    expect(r.ok).toBe(true);
    expect(s.asked).toEqual(Array(3).fill('https://x/health/ready'));
  });

  test('never ready: gives up with the last answer', async () => {
    const s = site([503]);
    const r = await waitUntilReady('https://x', {
      timeoutMs: 50,
      intervalMs: 10,
      fetchImpl: s.fetchImpl,
    });
    expect(r).toEqual({ ok: false, last: '503 {"status":"down","component":"db"}' });
    expect(s.asked.length).toBeGreaterThan(1);
  });
});
