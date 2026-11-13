/**
 * Just enough of a tRPC client to seed the demo workspace through the
 * api, as the app itself would: plain JSON over HTTP, no transformer.
 */
import type { Locale } from '@compass/i18n';
import { API_URL } from '../env';
import { signInitData } from '../tests/initData';

export interface Login {
  accessToken: string;
  refreshToken: string;
  session: {
    user: { id: string };
    member: { memberId: string; orgId: string };
  } & Record<string, unknown>;
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  input: unknown,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  // The routes that take an idempotency key want one (IDEMPOTENT_ROUTES).
  if (method === 'POST') headers['x-idempotency-key'] = `tutorial-${crypto.randomUUID()}`;
  const url =
    method === 'GET'
      ? `${API_URL}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`
      : `${API_URL}/trpc/${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}),
    });
    // Sign-in is rate limited; six people sign in within a few seconds.
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    const body = (await res.json()) as { result?: { data: T }; error?: unknown };
    if (!res.ok || !body.result) {
      throw new Error(`${path} failed (${res.status}): ${JSON.stringify(body.error ?? body)}`);
    }
    return body.result.data;
  }
}

export const mutate = <T = unknown>(token: string, path: string, input: unknown): Promise<T> =>
  call<T>('POST', path, input, token);
export const query = <T = unknown>(token: string, path: string, input: unknown): Promise<T> =>
  call<T>('GET', path, input, token);

/**
 * Sign a demo person in the way Telegram does (a real, refreshable
 * session), confirm their name and set their language.
 */
export async function signIn(tgUserId: string, name: string, locale: Locale): Promise<Login> {
  const login = await call<{ tokens: { accessToken: string; refreshToken: string } }>(
    'POST',
    'auth.telegramLogin',
    { initData: signInitData(tgUserId, { first_name: name, language_code: locale }), locale },
  );
  const token = login.tokens.accessToken;
  await mutate(token, 'auth.completeOnboarding', { displayName: name });
  const session = await mutate<Login['session']>(token, 'auth.setLocale', { locale });
  return { accessToken: token, refreshToken: login.tokens.refreshToken, session };
}
