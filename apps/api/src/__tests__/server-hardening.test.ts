/**
 * Reviews COREAPI-21 and COREAPI-27 (2026-11-12): what the public
 * readiness check tells a stranger, the level an anonymous client's log
 * line reaches the journal with, and a production server that cannot sign
 * anyone in.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { assertProductionLogin, releaseChannelOf } from '../env';
import { readinessHandler } from '../http/health';
import { journalLevel, maskedText } from '../trpc/routers/system';

function readyApp(pingDb: () => Promise<unknown>, logged: unknown[]) {
  const app = new Hono();
  app.get(
    '/health/ready',
    readinessHandler({ pingDb, version: () => 'abc123', onDbError: (err) => logged.push(err) }),
  );
  return app;
}

describe('/health/ready (COREAPI-21)', () => {
  test('a failed database round trip answers 503 and keeps the cause in the log', async () => {
    const logged: unknown[] = [];
    const cause = new Error('connect ECONNREFUSED 10.0.0.7:5432 (database "compass_prod")');
    const res = await readyApp(() => Promise.reject(cause), logged).request('/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'down', component: 'db' });
    expect(logged).toEqual([cause]);
  });

  test('a working database answers ok with the build', async () => {
    const logged: unknown[] = [];
    const res = await readyApp(() => Promise.resolve([]), logged).request('/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; dbMs: number };
    expect({ status: body.status, version: body.version }).toEqual({
      status: 'ok',
      version: 'abc123',
    });
    expect(typeof body.dbMs).toBe('number');
    expect(logged).toEqual([]);
  });
});

describe('client log lines in the journal (COREAPI-21)', () => {
  test('a signed-in client keeps its level', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(journalLevel(level, true)).toBe(level);
    }
  });

  test('an anonymous one is written at info at most', () => {
    expect(journalLevel('error', false)).toBe('info');
    expect(journalLevel('warn', false)).toBe('info');
    expect(journalLevel('info', false)).toBe('info');
    expect(journalLevel('debug', false)).toBe('debug');
  });
});

describe('client log text is masked before it is kept (MWD-15)', () => {
  test('clamped, then masked, and never longer than its column', () => {
    expect(maskedText('mail a@b.example now', 200)).toBe('mail [email] now');
    expect(maskedText(42, 200)).toBeNull();
    expect(maskedText('Bearer abcdefgh12345678', 10)!.length).toBeLessThanOrEqual(10);
    expect(maskedText('', 10)).toBe('');
  });
});

describe('production sign-in (COREAPI-27)', () => {
  test('the channel is COMPASS_RELEASE_CHANNEL, else production exactly when NODE_ENV is', () => {
    expect(releaseChannelOf({ NODE_ENV: 'production' })).toBe('production');
    expect(releaseChannelOf({ NODE_ENV: 'development' })).toBe('development');
    expect(releaseChannelOf({ NODE_ENV: 'test' })).toBe('development');
    expect(releaseChannelOf({ NODE_ENV: 'production', COMPASS_RELEASE_CHANNEL: 'staging' })).toBe(
      'staging',
    );
  });

  test('the production channel refuses to start without the bot token', () => {
    expect(() => assertProductionLogin({ NODE_ENV: 'production' })).toThrow(
      'TELEGRAM_BOT_TOKEN is required on the production channel',
    );
    expect(() =>
      assertProductionLogin({ NODE_ENV: 'test', COMPASS_RELEASE_CHANNEL: 'production' }),
    ).toThrow('TELEGRAM_BOT_TOKEN');
    expect(() =>
      assertProductionLogin({ NODE_ENV: 'production', TELEGRAM_BOT_TOKEN: '1:token' }),
    ).not.toThrow();
    expect(() => assertProductionLogin({ NODE_ENV: 'development' })).not.toThrow();
  });
});
