import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App initData verification per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export interface VerifyResult {
  ok: boolean;
  user?: TelegramUser;
  authDate?: number;
  reason?: string;
}

export function verifyInitData(initData: string, botToken: string, maxAgeSec = 86400): VerifyResult {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  // M1.9-fix (2026-05-07): use a constant-time compare to close a
  // timing oracle. Both `expected` and `hash` are 64-char hex from a
  // SHA-256 digest, so a length mismatch indicates malformed input
  // and we reject before timingSafeEqual (which throws on mismatched
  // lengths). The byte-buffer compare runs in O(len) regardless of
  // where the first differing byte sits — denying a network attacker
  // a per-byte signal under the auth.telegramLogin rate limit.
  if (expected.length !== hash.length) return { ok: false, reason: 'bad signature' };
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(hash, 'hex');
  if (expectedBuf.length !== actualBuf.length) return { ok: false, reason: 'bad signature' };
  if (!timingSafeEqual(expectedBuf, actualBuf)) return { ok: false, reason: 'bad signature' };

  // M1.9-fix (2026-05-07): explicitly require auth_date to be PRESENT
  // before parsing. `Number(null)` coerces to 0, which is finite, so
  // the previous check would treat a missing auth_date as a 1970-epoch
  // timestamp and return 'expired' instead of 'no auth_date'. Caught
  // by the new unit test in __tests__/telegramAuth.test.ts.
  const rawAuthDate = params.get('auth_date');
  if (rawAuthDate == null || rawAuthDate === '') {
    return { ok: false, reason: 'no auth_date' };
  }
  const authDate = Number(rawAuthDate);
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'no auth_date' };
  // M1.22 (2026-05-08, launch hardening): tolerate ±600 s of clock
  // skew between the user's device and our server. Two real failure
  // modes the old strict-floor check produced:
  //   - User's iPhone clock 2 min slow → ageSec is positive but
  //     could legitimately exceed maxAgeSec on a stale initData
  //     by a few seconds. Strict check rejected.
  //   - User's iPhone clock AHEAD → ageSec computes as a SMALL
  //     NEGATIVE NUMBER (server clock is now < auth_date), which
  //     passes `ageSec > maxAgeSec` but is logically "future date".
  //     Should still pass since the data IS fresh, just from the
  //     future. Old code did pass it; we make that explicit.
  // The ±600 s window matches Telegram's own server-side tolerance
  // for initData and Cloudflare's NTP-step thresholds. Beyond the
  // window we reject as either expired or "too far in future".
  const CLOCK_SKEW_TOLERANCE_SEC = 600;
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > maxAgeSec + CLOCK_SKEW_TOLERANCE_SEC) {
    return { ok: false, reason: 'expired' };
  }
  if (ageSec < -CLOCK_SKEW_TOLERANCE_SEC) {
    return { ok: false, reason: 'auth_date too far in future' };
  }

  const userJson = params.get('user');
  if (!userJson) return { ok: false, reason: 'no user' };
  let user: TelegramUser;
  try {
    user = JSON.parse(userJson) as TelegramUser;
  } catch {
    return { ok: false, reason: 'bad user json' };
  }
  return { ok: true, user, authDate };
}
