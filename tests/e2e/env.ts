/**
 * Where the end-to-end run lives. Everything is overridable so CI and a
 * developer's machine can both point it at their own Postgres and ports.
 */
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'E2E_DATABASE_URL is not set. Point it at a database this run may WIPE, e.g.\n' +
      '  E2E_DATABASE_URL=postgres://compass:compass@localhost:5433/compass_e2e',
  );
}
if (!/e2e|test/i.test(new URL(databaseUrl).pathname)) {
  // global-setup drops every application schema. Refuse anything that
  // does not look like a throwaway database.
  throw new Error(
    `E2E_DATABASE_URL points at "${new URL(databaseUrl).pathname.slice(1)}". ` +
      'The database name must contain "e2e" or "test" — this run erases it.',
  );
}

export const DATABASE_URL = databaseUrl;
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5273);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Telegram id of the super admin the run signs in as. */
export const ADMIN_TG_ID = '900000001';

/**
 * Not a real bot. It lets a test sign Telegram initData the api will
 * accept, which is the only way to get a real, refreshable session: the
 * development logins hand out a placeholder refresh token on purpose.
 */
export const BOT_TOKEN = '900000001:e2e-not-a-real-bot-token';
