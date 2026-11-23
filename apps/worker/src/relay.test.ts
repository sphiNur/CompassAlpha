import { describe, expect, test } from 'bun:test';
import { assertRelayDelivered, RelayError } from './relay';

function verdict(status: number, body: string): RelayError | null {
  try {
    assertRelayDelivered(status, body);
    return null;
  } catch (err) {
    return err as RelayError;
  }
}

describe('assertRelayDelivered', () => {
  test('accepts a Bot API success', () => {
    expect(verdict(200, '{"ok":true,"result":{}}')).toBeNull();
  });

  test('a Bot API 403 / 400 is permanent', () => {
    const blocked = verdict(403, '{"ok":false,"error_code":403,"description":"bot was blocked"}');
    expect(blocked?.permanent).toBe(true);
    const badChat = verdict(400, '{"ok":false,"error_code":400,"description":"chat not found"}');
    expect(badChat?.permanent).toBe(true);
  });

  test('the relay rejecting our shared key keeps the message queued', () => {
    // tg-relay/worker.js: `new Response('forbidden', { status: 403 })`
    const err = verdict(403, 'forbidden');
    expect(err).toBeInstanceOf(RelayError);
    expect(err?.permanent).toBe(false);
  });

  test('other relay-side refusals and outages are transient', () => {
    for (const [status, body] of [
      [400, 'invalid json'],
      [400, 'method not allowed: sendPhoto'],
      [500, 'worker misconfigured: BOT_TOKEN unset'],
      [502, '<html>bad gateway</html>'],
    ] as const) {
      expect(verdict(status, body)?.permanent).toBe(false);
    }
  });

  test('the relay refusing our configuration holds the row without using a retry (plan 2.2)', () => {
    for (const [status, body] of [
      [403, 'forbidden'],
      [400, 'invalid json'],
      [404, 'not found'],
      [405, 'method not allowed: sendPhoto'],
    ] as const) {
      expect(verdict(status, body)?.ourConfiguration).toBe(true);
    }
    // Load, outages and the Bot API's own answers are not ours to fix.
    for (const [status, body] of [
      [429, 'slow down'],
      [408, 'timeout'],
      [502, '<html>bad gateway</html>'],
      [403, '{"ok":false,"error_code":403,"description":"bot was blocked"}'],
      [400, '{"ok":false,"error_code":400,"description":"chat not found"}'],
    ] as const) {
      expect(verdict(status, body)?.ourConfiguration).toBe(false);
    }
  });

  test('a Bot API rate limit or outage is transient', () => {
    expect(
      verdict(429, '{"ok":false,"error_code":429,"description":"retry later"}')?.permanent,
    ).toBe(false);
    expect(verdict(500, '{"ok":false,"error_code":500}')?.permanent).toBe(false);
  });
});
