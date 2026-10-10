/**
 * Staying signed in.
 *
 * An access token lives for 15 minutes; after that the app has to trade
 * its refresh token for a new pair and carry on without the user
 * noticing. For a long time it could not: the refresh endpoint rejected
 * every token the server issued, and nothing tested the two together.
 *
 * The development logins deliberately hand out a placeholder refresh
 * token, so this signs in the way Telegram does (signed initData) to get
 * a real one, then opens the app with an access token that is no good.
 */
import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ADMIN_TG_ID, API_URL, BOT_TOKEN } from '../env';

function signInitData(tgUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    user: JSON.stringify({ id: Number(tgUserId), first_name: 'E2E' }),
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

test('an expired access token is refreshed and the app carries on', async ({ page, request }) => {
  const login = await request.post(`${API_URL}/trpc/auth.telegramLogin`, {
    data: { initData: signInitData(ADMIN_TG_ID) },
  });
  expect(login.ok()).toBe(true);
  const { tokens, session } = (await login.json()).result.data;

  // Same origin, no app code: a place to seed storage before the app boots.
  await page.goto('/boot.css');
  await page.evaluate(
    ([refreshToken, sessionJson]) => {
      window.localStorage.setItem(
        'compass.auth',
        JSON.stringify({
          state: {
            accessToken: 'this.access.token-is-no-good',
            refreshToken,
            session: JSON.parse(sessionJson!),
            currentStoreId: null,
          },
          version: 0,
        }),
      );
    },
    [tokens.refreshToken as string, JSON.stringify(session)],
  );

  const calls: Array<{ path: string; status: number }> = [];
  page.on('response', (res) => {
    const match = /\/trpc\/(auth\.[A-Za-z]+)/.exec(res.url());
    if (match) calls.push({ path: match[1]!, status: res.status() });
  });

  await page.goto('/');
  // Signed in and showing data: the app proper, or first-run naming if
  // this spec is run on its own against a fresh database.
  await expect(
    page.getByTestId('primary-nav').or(page.getByRole('heading', { name: 'Welcome to Compass' })),
  ).toBeVisible();

  expect(calls).toContainEqual({ path: 'auth.refresh', status: 200 });
  // The session was kept, not silently replaced by a fresh sign-in.
  expect(calls.filter((c) => /Login$/.test(c.path))).toEqual([]);

  const stored = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem('compass.auth')!).state,
  );
  expect(stored.accessToken.split('.')).toHaveLength(3);
  expect(stored.accessToken).not.toBe('this.access.token-is-no-good');
  expect(stored.refreshToken.split('.')).toHaveLength(3);
  expect(stored.refreshToken).not.toBe(tokens.refreshToken);
  expect(stored.session.user.id).toBe(session.user.id);
});
