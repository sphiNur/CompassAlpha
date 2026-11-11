/**
 * Loads the repository's `.env` for every command (review OPS-41, 2026-11).
 *
 * index.ts imports this module before anything else. ES modules are
 * evaluated in the order they are imported, so the variables are set
 * before any command module, or @compass/db, is evaluated. The call used
 * to sit in commands/user.ts, and the org and platform commands saw the
 * `.env` only because index.ts happened to import that file as well.
 */
import { loadRepoEnv } from '@compass/db/env';

loadRepoEnv(import.meta.url);
