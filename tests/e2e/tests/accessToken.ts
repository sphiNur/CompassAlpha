/**
 * The access token the app signed in with, for a test that calls the api
 * as the same person. Review MWD-14 (modern-web-guidance: privacy): the
 * app keeps its tokens in memory now, not in localStorage, so a test
 * reads the last one off the sign-in and refresh answers instead.
 */
import type { Page } from '@playwright/test';

const SIGN_IN = /\/trpc\/auth\.(telegramLogin|devBypassLogin|devPersonaLogin|refresh)(\?|$)/;

/** Start before the app signs in; the function returns the latest token seen. */
export function watchAccessToken(page: Page): () => string | null {
  let latest: string | null = null;
  page.on('response', (res) => {
    if (!SIGN_IN.test(res.url()) || !res.ok()) return;
    void res
      .json()
      .then((body: { result?: { data?: { tokens?: { accessToken?: unknown } } } }) => {
        const token = body.result?.data?.tokens?.accessToken;
        if (typeof token === 'string') latest = token;
      })
      .catch(() => {});
  });
  return () => latest;
}
