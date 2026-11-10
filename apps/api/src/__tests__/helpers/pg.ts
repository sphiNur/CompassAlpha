/**
 * Shared by the API's PG-gated tests (review TEST1-01, 2026-11). Importing
 * it loads the repository's .env the way the server does, so a run from
 * apps/api finds DATABASE_URL; each test file used to carry its own copy
 * of a 20-line loader. Under NODE_ENV=test, packages/db refuses a database
 * not named for tests (`testDatabaseRefusal` in its client.ts), so a .env
 * pointing at the development database fails loudly instead of being
 * written to.
 */
import { loadRepoEnv } from '@compass/db/env';

loadRepoEnv(import.meta.url);

/** The PG-gated suites run when a database is configured, unless
 *  SKIP_PG_TESTS=1 (CI's unit job). */
export const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';
