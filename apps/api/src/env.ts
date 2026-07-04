import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

(function loadRootEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    COMPASS_RELEASE_CHANNEL: z.enum(['development', 'staging', 'production']).optional(),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().optional(),
    JWT_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_BOT_USERNAME: z.string().optional(),
    /** Local-only browser development identity. Never honored outside the
     * development release channel; see auth.telegramLogin. */
    DEV_MOCK_LOGIN_ENABLED: z.enum(['true', 'false']).optional(),
    NON_TELEGRAM_LOGIN_ENABLED: z.enum(['true', 'false']).optional(),
    NON_TELEGRAM_LOGIN_USERS: z.string().optional(),
    // Cloudflare Worker relay for outbound Bot API calls — used when the
    // host network blocks api.telegram.org. See infra/cloudflare/README.md.
    TG_RELAY_URL: z.string().url().optional(),
    COMPASS_RELAY_KEY: z.string().min(32).optional(),
    BOT_DELIVERY_ENABLED: z.enum(['true', 'false']).optional(),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_PUBLIC_BASE: z.string().url().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  },
  runtimeEnv: process.env as Record<string, string | undefined>,
  emptyStringAsUndefined: true,
});

export type Env = typeof env;
