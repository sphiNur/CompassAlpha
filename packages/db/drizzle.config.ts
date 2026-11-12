import type { Config } from 'drizzle-kit';

/**
 * For `pnpm db:studio` only. Review DB-24 (2026-11-12): without a URL in
 * the environment this fell back to a database on port 5432, while the
 * dev compose maps Postgres to 5433, so studio opened another database.
 * It now says what is missing. `out` is not `migrations/`: those are
 * written by hand, and `drizzle-kit generate` run directly would have
 * written over their journal (out/ is ignored by git).
 */
const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error('Set DATABASE_URL_DIRECT or DATABASE_URL to the database to open.');
}

export default {
  schema: './src/schema/index.ts',
  out: './out',
  dialect: 'postgresql',
  dbCredentials: { url },
  schemaFilter: ['auth', 'inventory', 'domain', 'read_model', 'ops', 'sync'],
  verbose: true,
  strict: true,
} satisfies Config;
