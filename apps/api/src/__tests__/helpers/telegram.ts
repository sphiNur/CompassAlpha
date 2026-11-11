/**
 * Telegram identities for the API tests (review TEST1-05, TEST1-18,
 * 2026-11). The signature is computed here, the way Telegram documents
 * it, and not by the code under test, so a sign-in test does not check
 * services/telegramAuth.ts against itself.
 */
import { createHmac } from 'node:crypto';
import { noteTgId } from './cleanup';

/**
 * `fields` as a Mini App receives them from Telegram: URL-encoded, with
 * `hash` = HMAC-SHA256(HMAC-SHA256("WebAppData", botToken), the sorted
 * "key=value" lines). A `hash` entry in `fields` is dropped and signed afresh.
 */
export function signFields(fields: Record<string, string>, botToken: string): string {
  const entries = Object.entries(fields).filter(([key]) => key !== 'hash');
  const dataCheckString = entries
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const params = new URLSearchParams(entries);
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

export interface InitDataUser {
  firstName?: string;
  username?: string;
  languageCode?: string;
}

/**
 * initData for one Telegram user, signed now with the bot token the API
 * checks against (TELEGRAM_BOT_TOKEN; the suites that sign in skip
 * themselves without one).
 */
export function signInitData(tgUserId: bigint, user: InitDataUser = {}): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error('signInitData needs TELEGRAM_BOT_TOKEN');
  return signFields(
    {
      auth_date: Math.floor(Date.now() / 1000).toString(),
      user: JSON.stringify({
        id: Number(tgUserId),
        first_name: user.firstName ?? 'Test',
        username: user.username ?? `u${tgUserId}`,
        ...(user.languageCode ? { language_code: user.languageCode } : {}),
      }),
    },
    botToken,
  );
}

// Starts at a random place so two runs against one database in the same
// millisecond are unlikely to meet.
let sequence = Math.floor(Math.random() * 100);

/**
 * A Telegram user id no earlier test has used: the clock in milliseconds,
 * then a two-digit counter. users.tg_user_id is unique and some test data
 * outlives its run (see cleanup.ts), so ids must differ across runs as well
 * as within one. The counter trails the clock: hand-made ids that put a
 * distinguishing digit in front of Date.now() and then kept the last 12
 * digits cut it off again (TEST1-18). Distinct as long as a process asks
 * for at most 100 a millisecond. About 1.8e14 today, 15 digits: the most
 * admin.memberInviteByTgId accepts, and a safe JS integer, so `Number(id)`
 * in initData is exact.
 *
 * The id is noted for the clean-up, so a user the API makes for it (at
 * sign-in, on accepting an invite) is removed with the file's other rows.
 */
export function freshTgId(): bigint {
  sequence = (sequence + 1) % 100;
  return noteTgId(BigInt(Date.now()) * 100n + BigInt(sequence));
}
