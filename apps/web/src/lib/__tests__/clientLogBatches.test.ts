/**
 * Client logs reach the server after an outage (COREAPI-04, 2026-11-09).
 *
 * The logger sent its whole queue (up to 500 events) in one call; the
 * server takes at most CLIENT_LOG_BATCH_MAX, refused it, and the batch was
 * queued again and refused again on every flush. A keepalive body above
 * 64 KiB failed the same way. The queue now goes in batches the server
 * accepts, and a batch it refuses is dropped.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { CLIENT_LOG_BATCH_MAX, CLIENT_LOG_BATCH_MAX_BYTES } from '@compass/contracts/limits';
import {
  BatchRefused,
  initLogger,
  KEEPALIVE_BUDGET_BYTES,
  logBatches,
  type LogEvent,
  type TransportOptions,
} from '@compass/telemetry';
import { sendClientLogs } from '../trpc';

const event = (i: number, extra: Partial<LogEvent> = {}): LogEvent => ({
  sessionId: 's',
  level: 'warn',
  kind: 'test',
  action: `a${i}`,
  clientTs: i,
  ...extra,
});
const events = (n: number) => Array.from({ length: n }, (_, i) => event(i));
const bodyBytes = (batch: LogEvent[]) =>
  new TextEncoder().encode(JSON.stringify({ events: batch })).length;

describe('logBatches', () => {
  it('splits by count, in order', () => {
    const batches = logBatches(events(450), CLIENT_LOG_BATCH_MAX, CLIENT_LOG_BATCH_MAX_BYTES);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat().map((e) => e.clientTs)).toEqual(events(450).map((e) => e.clientTs));
  });

  it('splits by size: no request body above the limit', () => {
    const big = Array.from({ length: 120 }, (_, i) => event(i, { errorStack: 'x'.repeat(2_000) }));
    const batches = logBatches(big, CLIENT_LOG_BATCH_MAX, CLIENT_LOG_BATCH_MAX_BYTES);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(bodyBytes(b)).toBeLessThanOrEqual(CLIENT_LOG_BATCH_MAX_BYTES);
    expect(batches.flat()).toHaveLength(120);
  });

  it('cuts an event too big for a batch of its own to what the server keeps', () => {
    const huge = event(1, {
      errorStack: '字'.repeat(30_000),
      data: { blob: 'y'.repeat(100_000) },
    });
    const [batch] = logBatches([huge], CLIENT_LOG_BATCH_MAX, CLIENT_LOG_BATCH_MAX_BYTES);
    expect(batch![0]!.data).toEqual({ _truncated: true });
    expect(batch![0]!.errorStack).toHaveLength(8_000);
    expect(bodyBytes(batch!)).toBeLessThanOrEqual(CLIENT_LOG_BATCH_MAX_BYTES);
  });
});

describe('the logger flush', () => {
  const loggers: Array<{ destroy(): void }> = [];
  afterEach(() => {
    for (const l of loggers.splice(0)) l.destroy();
  });

  /** A logger with `n` queued events and a transport the test scripts. */
  function loggerWith(n: number, answer: (batch: LogEvent[], call: number) => Promise<void>) {
    const logger = initLogger({
      appVersion: 'test',
      flushIntervalMs: 3_600_000,
      maxBatchEvents: 100,
      maxBatchBytes: CLIENT_LOG_BATCH_MAX_BYTES,
    });
    loggers.push(logger);
    for (let i = 0; i < n; i++) logger.log('warn', 'test', { action: `a${i}` });
    const sent: LogEvent[][] = [];
    let calls = 0;
    logger.setTransport(async (batch) => {
      calls++;
      await answer(batch, calls);
      sent.push(batch);
    });
    return { logger, sent };
  }

  it('drops a batch the server refused and sends the rest', async () => {
    const { logger, sent } = loggerWith(250, async (_batch, call) => {
      if (call === 1) throw new BatchRefused(400);
    });
    await logger.flush();
    expect(sent.map((b) => b.length)).toEqual([100, 50]);
    await logger.flush();
    expect(sent).toHaveLength(2); // nothing left to send
  });

  it('queues again what did not get through, in order', async () => {
    let online = false;
    const { logger, sent } = loggerWith(250, async (_batch, call) => {
      if (call === 2 && !online) throw new TypeError('Failed to fetch');
    });
    await logger.flush();
    expect(sent.map((b) => b.length)).toEqual([100]);
    online = true;
    await logger.flush();
    expect(sent.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(sent.flat().map((e) => e.action)).toEqual(
      Array.from({ length: 250 }, (_, i) => `a${i}`),
    );
  });
});

/**
 * Review MWD-01 (modern-web-guidance: batch-analytics-events): the send on
 * hide went over the browser's ~64 KiB keepalive quota and lost what did
 * not fit. It now sends what fits and keeps the rest for the next start.
 */
describe('the flush on hide', () => {
  const loggers: Array<{ destroy(): void }> = [];
  afterEach(() => {
    for (const l of loggers.splice(0)) l.destroy();
  });

  function memoryStorage() {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    };
  }

  function bigLogger(storage: ReturnType<typeof memoryStorage>, n: number) {
    const logger = initLogger({
      appVersion: 'test',
      flushIntervalMs: 3_600_000,
      maxBatchEvents: CLIENT_LOG_BATCH_MAX,
      maxBatchBytes: CLIENT_LOG_BATCH_MAX_BYTES,
      storage,
    });
    loggers.push(logger);
    for (let i = 0; i < n; i++) {
      logger.log('error', 'test', { action: `a${i}`, errorStack: 'x'.repeat(2_000) });
    }
    return logger;
  }

  type Call = { batch: LogEvent[]; options?: TransportOptions; settle: () => void };

  it('sends only what fits in the keepalive quota, in order, and keeps the rest', async () => {
    const storage = memoryStorage();
    const logger = bigLogger(storage, 100);
    const calls: Call[] = [];
    logger.setTransport(
      (batch, options) =>
        new Promise<void>((settle) => calls.push({ batch, options, settle: () => settle() })),
    );
    await logger.flush(true);
    const sentBytes = calls.reduce((sum, c) => sum + bodyBytes(c.batch), 0);
    expect(calls.length).toBeGreaterThan(0);
    expect(sentBytes).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
    expect(calls.every((c) => c.options?.keepalive === true)).toBe(true);
    const sent = calls.flatMap((c) => c.batch.map((e) => e.action));
    expect(sent).toEqual(Array.from({ length: sent.length }, (_, i) => `a${i}`));

    // The rest is kept for the next start, in order.
    const kept = JSON.parse(storage.items.get('compass.session.unsent')!) as LogEvent[];
    expect(kept.map((e) => e.action)).toEqual(
      Array.from({ length: 100 - sent.length }, (_, i) => `a${i + sent.length}`),
    );

    // A second hide while the first send is in flight has no room left.
    const before = calls.length;
    await logger.flush(true);
    expect(calls).toHaveLength(before);

    // Once it is answered, the next hide sends the next part.
    for (const c of calls) c.settle();
    await Promise.resolve();
    await Promise.resolve();
    await logger.flush(true);
    expect(calls.length).toBeGreaterThan(before);
    expect(calls[before]!.batch[0]!.action).toBe(`a${sent.length}`);
  });

  it('the next start sends what was kept, first, and clears the copy', async () => {
    const storage = memoryStorage();
    const first = bigLogger(storage, 100);
    first.setTransport(() => new Promise<void>(() => undefined)); // never answered
    await first.flush(true);
    const kept = JSON.parse(storage.items.get('compass.session.unsent')!) as LogEvent[];
    expect(kept.length).toBeGreaterThan(0);

    const next = initLogger({
      appVersion: 'test',
      flushIntervalMs: 3_600_000,
      maxBatchEvents: CLIENT_LOG_BATCH_MAX,
      maxBatchBytes: CLIENT_LOG_BATCH_MAX_BYTES,
      storage,
    });
    loggers.push(next);
    expect(storage.items.has('compass.session.unsent')).toBe(false);
    next.log('warn', 'test', { action: 'new' });
    const sent: LogEvent[] = [];
    next.setTransport(async (batch) => void sent.push(...batch));
    await next.flush();
    expect(sent.map((e) => e.action)).toEqual([...kept.map((e) => e.action), 'new']);
  });

  it('queues again a send on hide that failed, unless it was refused', async () => {
    const storage = memoryStorage();
    const logger = initLogger({
      appVersion: 'test',
      flushIntervalMs: 3_600_000,
      maxBatchEvents: CLIENT_LOG_BATCH_MAX,
      maxBatchBytes: CLIENT_LOG_BATCH_MAX_BYTES,
      storage,
    });
    loggers.push(logger);
    logger.log('warn', 'test', { action: 'lost' });
    let fail: Error = new TypeError('Failed to fetch');
    logger.setTransport(async () => {
      throw fail;
    });
    await logger.flush(true);
    await new Promise((r) => setTimeout(r, 0));
    logger.log('warn', 'test', { action: 'refused' });
    const sent: LogEvent[] = [];
    logger.setTransport(async (batch) => void sent.push(...batch));
    await logger.flush();
    expect(sent.map((e) => e.action)).toEqual(['lost', 'refused']);

    fail = new BatchRefused(400);
    logger.setTransport(async () => {
      throw fail;
    });
    logger.log('warn', 'test', { action: 'gone' });
    await logger.flush(true);
    await new Promise((r) => setTimeout(r, 0));
    sent.length = 0;
    logger.setTransport(async (batch) => void sent.push(...batch));
    await logger.flush();
    expect(sent).toHaveLength(0);
  });
});

describe('sendClientLogs', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const answering = (status: number) => {
    globalThis.fetch = (async () => new Response('{}', { status })) as unknown as typeof fetch;
  };

  it('a refused batch is BatchRefused, so the logger drops it', async () => {
    answering(400);
    await expect(sendClientLogs([event(1)])).rejects.toBeInstanceOf(BatchRefused);
    answering(413);
    await expect(sendClientLogs([event(1)])).rejects.toBeInstanceOf(BatchRefused);
  });

  it('keepalive only when asked, and at low priority (MWD-01, MWD-03)', async () => {
    const inits: RequestInit[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      inits.push(init);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await sendClientLogs([event(1)]);
    await sendClientLogs([event(2)], { keepalive: true });
    expect(inits.map((i) => i.keepalive)).toEqual([false, true]);
    expect(inits.map((i) => i.priority)).toEqual(['low', 'low']);
  });

  it('too many requests or a server error is queued again', async () => {
    for (const status of [429, 500, 503]) {
      answering(status);
      const err = await sendClientLogs([event(1)]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(BatchRefused);
    }
    answering(200);
    await expect(sendClientLogs([event(1)])).resolves.toBeUndefined();
  });
});
