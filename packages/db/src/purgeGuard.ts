/**
 * Refuse the whole-database wipe scripts on production (D5, 2026-10-30).
 *
 * purge-fake-data.ts deletes every tenant's events, read models, catalog
 * and stores with no WHERE. It loads the repo-root .env, which on the
 * server is the production DSN, and `--apply` was its only gate.
 *
 * The production api's NODE_ENV comes from its systemd unit, not from
 * .env, so a script started by hand on the server would not see it.
 * Production is therefore recognised by any of:
 *   - NODE_ENV=production or COMPASS_RELEASE_CHANNEL=production;
 *   - the installed api unit (/etc/systemd/system/compass-api.service),
 *     which only a production box has (deploy.ts installs it).
 * COMPASS_ALLOW_BULK_PURGE=true in the environment overrides, for a
 * deliberate maintenance window — the same switch as the api's
 * workspace-wide purges.
 */
import { existsSync } from 'node:fs';

export const PRODUCTION_UNIT_MARKER = '/etc/systemd/system/compass-api.service';

export interface PurgeGuardInput {
  env: Record<string, string | undefined>;
  unitInstalled: boolean;
}

/** Why this looks like production, or null when it does not. */
export function productionReason(input: PurgeGuardInput): string | null {
  const { env } = input;
  if (env.NODE_ENV === 'production') return 'NODE_ENV=production';
  if (env.COMPASS_RELEASE_CHANNEL === 'production') return 'COMPASS_RELEASE_CHANNEL=production';
  if (input.unitInstalled) return `${PRODUCTION_UNIT_MARKER} is installed on this host`;
  return null;
}

/** null when the wipe may run; otherwise the reason it may not. */
export function wipeRefusal(input: PurgeGuardInput): string | null {
  if (input.env.COMPASS_ALLOW_BULK_PURGE === 'true') return null;
  return productionReason(input);
}

export function currentWipeRefusal(): string | null {
  return wipeRefusal({ env: process.env, unitInstalled: existsSync(PRODUCTION_UNIT_MARKER) });
}
