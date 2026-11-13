import { createHmac } from 'node:crypto';
import { BOT_TOKEN } from '../env';

/**
 * initData for `tgUserId`, signed the way Telegram signs it with the bot
 * token the api under test checks. `user` adds to or replaces Telegram's
 * user fields (the tutorial signs its demo people in by name). Review
 * OPS-46 (2026-11-11): two specs kept a copy each.
 */
export function signInitData(
  tgUserId: string,
  user: { first_name?: string; language_code?: string } = {},
): string {
  const fields: Record<string, string> = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    user: JSON.stringify({ id: Number(tgUserId), first_name: 'E2E', ...user }),
  };
  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}
