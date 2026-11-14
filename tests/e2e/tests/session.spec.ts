/**
 * Staying signed in.
 *
 * An access token lives for 15 minutes; after that the app has to trade
 * its refresh token for a new pair and carry on without the user
 * noticing. For a long time it could not: the refresh endpoint rejected
 * every token the server issued, and nothing tested the two together.
 *
 * Review MWD-14 (modern-web-guidance: privacy): the app no longer saves
 * either token. The access token is in memory and the refresh token in an
 * HttpOnly cookie the api sets. This opens the app with a sign-in saved
 * the way an older build saved it (an access token that is no good and a
 * refresh token), so it also covers the move: the saved refresh token is
 * sent once, the api sets the cookie, nothing secret stays in storage, and
 * a reload renews the session from the cookie alone.
 *
 * Signs in the way Telegram does (signed initData), outside the page, so
 * the page starts with no cookie of its own.
 */
import { expect, test } from '@playwright/test';
import { ADMIN_TG_ID, API_URL } from '../env';
import { signInitData } from './initData';

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

  // The shell is drawn from the stored session before the refresh has
  // come back, so wait for it rather than expecting it already.
  await expect.poll(() => calls).toContainEqual({ path: 'auth.refresh', status: 200 });
  // The session was kept, not silently replaced by a fresh sign-in.
  expect(calls.filter((c) => /Login$/.test(c.path))).toEqual([]);

  // Nothing secret is saved any more: the session, and in place of the
  // refresh token a placeholder an older build would be refused with.
  await expect
    .poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem('compass.auth')!).state))
    .toMatchObject({ refreshToken: 'mwd14-refresh-token-is-in-a-cookie' });
  const stored = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem('compass.auth')!).state,
  );
  expect(stored).not.toHaveProperty('accessToken');
  expect(stored.session.user.id).toBe(session.user.id);
  expect(JSON.stringify(stored)).not.toContain(tokens.refreshToken);

  // The refresh token is now an HttpOnly cookie, sent only to auth.refresh.
  const cookies = await page.context().cookies();
  const cookie = cookies.find((c) => c.name === 'compass_rt');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.path).toBe('/trpc/auth.refresh');
  expect(cookie?.value.split('.')).toHaveLength(3);
  expect(cookie?.value).not.toBe(tokens.refreshToken);

  // A reload has no token at all: it renews from the cookie, no sign-in.
  calls.length = 0;
  const refreshBodies: unknown[] = [];
  page.on('request', (req) => {
    if (/\/trpc\/auth\.refresh/.test(req.url())) refreshBodies.push(req.postDataJSON());
  });
  await page.reload();
  await expect(
    page.getByTestId('primary-nav').or(page.getByRole('heading', { name: 'Welcome to Compass' })),
  ).toBeVisible();
  await expect.poll(() => calls).toContainEqual({ path: 'auth.refresh', status: 200 });
  expect(refreshBodies[0]).toEqual({});
  expect(calls.filter((c) => /Login$/.test(c.path))).toEqual([]);
});
