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
import { BatchRefused, initLogger, logBatches, type LogEvent } from '@compass/telemetry';
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
