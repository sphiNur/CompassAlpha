/**
 * Does signing in from scratch work on a running instance?
 *
 *   TELEGRAM_BOT_TOKEN=<the instance's bot token> \
 *     bun scripts/login-check.ts <base url> <telegram user id>
 *
 * It does what the app does when it has no session at all: presents
 * Telegram sign-in data for that user, then makes an authenticated
 * request, then refreshes the token, then signs in a second time. Each
 * step touches the lookups that happen before the server knows which
 * organisation the person belongs to, which is what breaks first if
 * tenant-less queries are refused and one of them is not marked as a
 * system lookup.
 *
 * The sign-in data is signed with the bot token, exactly as Telegram
 * signs it, so the server cannot tell the difference: whoever holds the
 * token can sign in as any member. That is a property of Telegram
 * sign-in, not of this script, and the reason the token is a secret.
 *
 * It creates one refresh-token row per sign-in and changes nothing else.
 * Exit code 0 when every step passed.
 */
import { createHmac } from 'node:crypto';

const [baseArg, tgIdArg] = process.argv.slice(2);
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!baseArg || !tgIdArg || !botToken) {
  process.stderr.write(
    'usage: TELEGRAM_BOT_TOKEN=... bun scripts/login-check.ts <base url> <telegram user id>\n',
  );
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, '');

/**
 * Telegram's format, which is easy to get subtly wrong:
 *  - the signature is over `key=value` lines, sorted, joined by "\n",
 *    using the values as they are BEFORE URL-encoding;
 *  - what is sent is a URL query string, so each value IS URL-encoded,
 *    and `hash` is one more parameter of it.
 * Appending `&hash=` to the newline-joined text does not work: the server
 * then reads a single parameter called `auth_date` and finds no `user`.
 */
function signInitData(tgUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    user: JSON.stringify({ id: Number(tgUserId), first_name: 'login-check' }),
  };
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken!).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

interface Reply {
  status: number;
  data?: Record<string, unknown>;
  error?: string;
}

async function call(
  path: string,
  options: { input?: unknown; token?: string; query?: boolean } = {},
): Promise<Reply> {
  const res = await fetch(`${base}/trpc/${path}`, {
    method: options.query ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.query ? {} : { body: JSON.stringify(options.input ?? {}) }),
  });
  const body = (await res.json().catch(() => null)) as {
    result?: { data?: Record<string, unknown> };
    error?: { message?: string };
  } | null;
  return { status: res.status, data: body?.result?.data, error: body?.error?.message };
}

let failed = false;
function report(step: string, ok: boolean, detail: string): void {
  if (!ok) failed = true;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail}\n`);
}

type Tokens = { accessToken: string; refreshToken: string };
type Session = { member?: { memberId?: string; orgSlug?: string }; stores?: unknown[] };

async function signIn(label: string): Promise<Tokens | null> {
  const reply = await call('auth.telegramLogin', { input: { initData: signInitData(tgIdArg!) } });
  const tokens = reply.data?.tokens as Tokens | undefined;
  const session = reply.data?.session as Session | undefined;
  report(
    label,
    reply.status === 200 && !!tokens?.accessToken && !!session?.member?.memberId,
    reply.status === 200
      ? `member ${session?.member?.memberId} in ${session?.member?.orgSlug}, ${session?.stores?.length ?? 0} stores`
      : `HTTP ${reply.status} ${reply.error ?? ''}`,
  );
  return tokens ?? null;
}

const first = await signIn('sign in with no session');
if (first) {
  const me = await call('auth.me', { token: first.accessToken, query: true });
  const session = me.data as Session | undefined;
  report(
    'authenticated request',
    me.status === 200 && !!session?.member?.memberId,
    me.status === 200
      ? `loaded member ${session?.member?.memberId}`
      : `HTTP ${me.status} ${me.error ?? ''}`,
  );

  const refreshed = await call('auth.refresh', { input: { refreshToken: first.refreshToken } });
  report(
    'refresh the token',
    refreshed.status === 200 && !!(refreshed.data?.tokens as Tokens | undefined)?.accessToken,
    refreshed.status === 200
      ? 'new tokens issued'
      : `HTTP ${refreshed.status} ${refreshed.error ?? ''}`,
  );

  await signIn('sign in again');
}

process.exit(failed ? 1 : 0);
