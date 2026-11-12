import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { loadRepoEnv } from '@compass/db/env';

loadRepoEnv(import.meta.url);

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    COMPASS_RELEASE_CHANNEL: z.enum(['development', 'staging', 'production']).optional(),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_BOT_USERNAME: z.string().optional(),
    /** Local-only browser development identity. Never honored outside the
     * development release channel; see auth.telegramLogin. */
    DEV_MOCK_LOGIN_ENABLED: z.enum(['true', 'false']).optional(),
    NON_TELEGRAM_LOGIN_ENABLED: z.enum(['true', 'false']).optional(),
    NON_TELEGRAM_LOGIN_USERS: z.string().optional(),
    // Review COREAPI-27 (2026-11-12): the Bot API relay settings
    // (TG_RELAY_URL, COMPASS_RELAY_KEY, BOT_DELIVERY_ENABLED) are the
    // worker's, checked by apps/worker/src/config.ts; the api sends nothing
    // to Telegram. REDIS_URL and OTEL_EXPORTER_OTLP_ENDPOINT were never read.
    // Shared with the app-proxy Worker: requests carrying it may name the
    // real client address for rate limiting (AUTH-6). See services/clientIp.ts.
    CLIENT_IP_PROXY_KEY: z.string().min(32).optional(),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z.string().optional(),
    /** Read when signing (services/s3.ts), which takes us-east-1 when unset. */
    S3_REGION: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_PUBLIC_BASE: z.string().url().optional(),
    /** D1 (2026-10-30): lets admin.purgeAllTestData / purgeByDate run on
     * production. Set it only for a maintenance window; see
     * services/bulkPurge.ts. */
    COMPASS_ALLOW_BULK_PURGE: z.enum(['true', 'false']).optional(),
  },
  runtimeEnv: process.env as Record<string, string | undefined>,
  emptyStringAsUndefined: true,
});

/**
 * Review COREAPI-20: login and refresh tokens are signed with different
 * keys. With one value in both, only their `typ` header would tell them
 * apart, and tokens signed before 2026-11-10 have none.
 */
export function assertDistinctTokenKeys(
  keys: Pick<Env, 'JWT_SECRET' | 'JWT_REFRESH_SECRET'>,
): void {
  if (keys.JWT_SECRET === keys.JWT_REFRESH_SECRET) {
    throw new Error(
      'Invalid environment variables: JWT_REFRESH_SECRET must differ from JWT_SECRET',
    );
  }
}
assertDistinctTokenKeys(env);

/**
 * Which release this server is: COMPASS_RELEASE_CHANNEL, else production
 * exactly when NODE_ENV is.
 */
export function releaseChannelOf(
  e: Pick<Env, 'COMPASS_RELEASE_CHANNEL' | 'NODE_ENV'>,
): 'development' | 'staging' | 'production' {
  return e.COMPASS_RELEASE_CHANNEL ?? (e.NODE_ENV === 'production' ? 'production' : 'development');
}

/**
 * Review COREAPI-27 (2026-11-12): without TELEGRAM_BOT_TOKEN a production
 * server started, then failed every sign-in with a server error. The
 * production channel signs in only through Telegram, so it now refuses to
 * start instead.
 */
export function assertProductionLogin(
  e: Pick<Env, 'COMPASS_RELEASE_CHANNEL' | 'NODE_ENV' | 'TELEGRAM_BOT_TOKEN'>,
): void {
  if (releaseChannelOf(e) === 'production' && !e.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'Invalid environment variables: TELEGRAM_BOT_TOKEN is required on the production channel',
    );
  }
}
assertProductionLogin(env);

export type Env = typeof env;
