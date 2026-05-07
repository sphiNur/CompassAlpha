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

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'no auth_date' };
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > maxAgeSec) return { ok: false, reason: 'expired' };

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
