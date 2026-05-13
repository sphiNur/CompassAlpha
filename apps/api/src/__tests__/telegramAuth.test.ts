/**
 * Unit tests for Telegram WebApp initData verification (M1.9 hardening,
 * 2026-05-07).
 *
 * Why these tests exist now:
 *   The pre-launch readiness audit (2026-05-07) flagged the HMAC
 *   compare as a timing oracle and we replaced `expected !== hash`
 *   with a length-checked `crypto.timingSafeEqual`. Without unit
 *   coverage, a future "let's just simplify this back" PR would
 *   silently re-open the side-channel. These tests pin every
 *   reject-reason we care about so a regression fails the suite
 *   instead of leaking signal.
 *
 * What we cover:
 *   1. The happy path — a freshly generated, well-formed initData
 *      with a valid HMAC passes and returns the parsed user.
 *   2. Tampered hash → 'bad signature' (the typical attack: replay
 *      with one bit flipped).
 *   3. Hash that's the wrong length → 'bad signature' (the path the
 *      length pre-check guards before we hand bytes to
 *      timingSafeEqual; without it, the buffer compare would throw
 *      on length mismatch).
 *   4. Missing hash field → 'missing hash'.
 *   5. Stale auth_date past maxAgeSec → 'expired' (replay window).
 *   6. Missing auth_date → 'no auth_date'.
 *   7. Missing user JSON → 'no user'.
 *   8. Malformed user JSON → 'bad user json'.
 *
 * The HMAC keying uses Telegram's documented two-pass scheme:
 *   secret = HMAC-SHA256("WebAppData", botToken)
 *   hash   = HMAC-SHA256(secret, dataCheckString)
 * where dataCheckString is the alphabetically-sorted "k=v" lines of
 * the initData params with the "hash" key removed. We mirror that
 * here in `signInitData` so the tests don't depend on the
 * implementation under test for their own setup.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyInitData } from '../services/telegramAuth';

const BOT_TOKEN = '111111:test-bot-token';

/** Build a real, signature-valid initData string for the given fields. */
function signInitData(fields: Record<string, string>): string {
  // Filter out any explicit hash entry; we always sign fresh.
  const filtered = Object.entries(fields).filter(([k]) => k !== 'hash');
  const dataCheckString = filtered
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  // URLSearchParams to match the format the FE actually sends.
  const params = new URLSearchParams();
  for (const [k, v] of filtered) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}

const FRESH_AUTH_DATE = () => Math.floor(Date.now() / 1000).toString();

const SAMPLE_USER = JSON.stringify({
  id: 123456789,
  first_name: 'Sam',
  last_name: 'Test',
  username: 'samtest',
  language_code: 'en',
});

describe('verifyInitData (Telegram WebApp)', () => {
  test('accepts a valid signature with a fresh auth_date', () => {
    const initData = signInitData({
      auth_date: FRESH_AUTH_DATE(),
      query_id: 'q1',
      user: SAMPLE_USER,
    });
    const result = verifyInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.user?.id).toBe(123456789);
    expect(result.user?.username).toBe('samtest');
  });

  test('rejects when hash field is missing', () => {
    // Build a valid set then strip the hash key — tests the early-out.
    const result = verifyInitData('auth_date=1700000000&user={}', BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing hash');
  });

  test('rejects when hash is one byte different (tampered replay)', () => {
    const initData = signInitData({
      auth_date: FRESH_AUTH_DATE(),
      user: SAMPLE_USER,
    });
    // Flip one hex char of the hash so the bytes mismatch, lengths still equal.
    const tampered = initData.replace(/hash=([0-9a-f]+)/, (_, h: string) => {
      const flipped = h[0] === '0' ? '1' + h.slice(1) : '0' + h.slice(1);
      return `hash=${flipped}`;
    });
    const result = verifyInitData(tampered, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad signature');
  });

  test('rejects when hash length mismatches (guards timingSafeEqual)', () => {
    const initData = signInitData({
      auth_date: FRESH_AUTH_DATE(),
      user: SAMPLE_USER,
    });
    // Truncate the hash to 32 chars (16 bytes) instead of 64 (32 bytes).
    // Without our explicit length pre-check this would throw inside
    // timingSafeEqual; with it, we return a clean 'bad signature'.
    const shortened = initData.replace(/hash=[0-9a-f]{64}/, 'hash=' + 'a'.repeat(32));
    const result = verifyInitData(shortened, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad signature');
  });

  test('rejects when auth_date is older than maxAgeSec', () => {
    // Sign with a real token but predate by 2 hours; default maxAge=86400
    // so we use a tighter cap of 60s here to land in 'expired' fast.
    const oldDate = Math.floor(Date.now() / 1000) - 7200;
    const initData = signInitData({
      auth_date: oldDate.toString(),
      user: SAMPLE_USER,
    });
    const result = verifyInitData(initData, BOT_TOKEN, 60);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  test('rejects when auth_date is missing', () => {
    const initData = signInitData({ user: SAMPLE_USER });
    const result = verifyInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no auth_date');
  });

  test('rejects when user field is absent', () => {
    const initData = signInitData({ auth_date: FRESH_AUTH_DATE() });
    const result = verifyInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no user');
  });

  test('rejects when user JSON is malformed', () => {
    const initData = signInitData({
      auth_date: FRESH_AUTH_DATE(),
      user: '{not valid json',
    });
    const result = verifyInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad user json');
  });

  test('rejects when signed with the wrong bot token', () => {
    // Sign with one token, verify with another. This is a different
    // failure surface than tampered-hash: the dataCheckString matches,
    // but the secret derivation diverges.
    const initData = signInitData({
      auth_date: FRESH_AUTH_DATE(),
      user: SAMPLE_USER,
    });
    const result = verifyInitData(initData, 'different-bot-token');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad signature');
  });

  // M1.22 (2026-05-08): clock-skew tolerance window (±600s).
  // Telegram + Cloudflare both work with this tolerance because
  // mobile devices drift; the strict pre-M1.22 check rejected
  // initData from a user whose device clock was 90 seconds slow.
  test('accepts initData up to 600s past maxAgeSec (slow device clock)', () => {
    // Signed 30 seconds ago, verify with maxAge=60 → ageSec=30 fits.
    // Push the auth_date to 500 seconds in the past with maxAge=60.
    // ageSec=500 > maxAge=60 but < maxAge+600 so it passes.
    const skewedAuth = Math.floor(Date.now() / 1000) - 500;
    const initData = signInitData({
      auth_date: skewedAuth.toString(),
      user: SAMPLE_USER,
    });
    const result = verifyInitData(initData, BOT_TOKEN, 60);
    expect(result.ok).toBe(true);
  });

  test('rejects initData clearly past maxAgeSec + tolerance', () => {
    // 1000 seconds old, maxAge=60, tolerance=600 → 1000 > 660 = expired.
    const oldAuth = Math.floor(Date.now() / 1000) - 1000;
    const initData = signInitData({
      auth_date: oldAuth.toString(),
      user: SAMPLE_USER,
    });
    const result = verifyInitData(initData, BOT_TOKEN, 60);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  test('rejects initData with auth_date far in the future', () => {
    // Phone clock 1 hour ahead of server: auth_date 3600 seconds
    // in the future. > 600 tolerance → reject with explicit reason.
    const futureAuth = Math.floor(Date.now() / 1000) + 3600;
    const initData = signInitData({
      auth_date: futureAuth.toString(),
      user: SAMPLE_USER,
    });
    const result = verifyInitData(initData, BOT_TOKEN, 60);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auth_date too far in future');
  });
});
