/**
 * The worker's settings from the environment, checked once at start
 * (review COREAPI-27, 2026-11-12).
 *
 * main.ts read process.env directly, and a value that was wrong passed
 * without a word: CLAIM_TIMEOUT_MINUTES=3O parsed as NaN, `NaN > 0` is
 * false, and the stale-claim release was off while the log said "=0". A
 * value that is set but not understood now stops the worker at start, as
 * the API's env.ts does for its own settings (both read the same .env).
 */

export interface WorkerConfig {
  databaseUrl: string;
  /** Cloudflare Worker relay for the Bot API, with its shared key; null when not set. */
  relayUrl: string | null;
  relayKey: string | null;
  botToken: string | null;
  /** BOT_DELIVERY_ENABLED; null when unset (then on exactly when the relay is set). */
  botDeliveryEnabled: boolean | null;
  /** The app's address, the base of the notifications' buttons; null when not set. */
  frontendUrl: string | null;
  /** Minutes a claim may sit idle before it is released; 0 turns the release off. */
  claimTimeoutMinutes: number;
  /** Minutes between two scans for idle claims. */
  claimTimeoutScanMinutes: number;
}

type Env = Record<string, string | undefined>;

/** The settings, or an Error naming every value that is wrong. */
export function readWorkerConfig(env: Env): WorkerConfig {
  const problems: string[] = [];
  const text = (name: string): string | null => {
    const value = env[name]?.trim();
    return value ? value : null;
  };
  const url = (name: string): string | null => {
    const value = text(name);
    if (value === null) return null;
    try {
      new URL(value);
      return value;
    } catch {
      problems.push(`${name} is not a URL`);
      return null;
    }
  };
  const minutes = (name: string, fallback: number, min: number): number => {
    const value = text(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < min) {
      problems.push(`${name} must be a whole number of minutes, at least ${min}`);
      return fallback;
    }
    return Number(value);
  };

  const databaseUrl = text('DATABASE_URL');
  if (databaseUrl === null) problems.push('DATABASE_URL is required');
  const delivery = text('BOT_DELIVERY_ENABLED')?.toLowerCase() ?? null;
  if (delivery !== null && delivery !== 'true' && delivery !== 'false') {
    problems.push('BOT_DELIVERY_ENABLED must be true or false');
  }
  const config: WorkerConfig = {
    databaseUrl: databaseUrl ?? '',
    relayUrl: url('TG_RELAY_URL'),
    relayKey: text('COMPASS_RELAY_KEY'),
    botToken: text('TELEGRAM_BOT_TOKEN'),
    botDeliveryEnabled: delivery === null ? null : delivery === 'true',
    frontendUrl: url('FRONTEND_URL'),
    claimTimeoutMinutes: minutes('CLAIM_TIMEOUT_MINUTES', 30, 0),
    claimTimeoutScanMinutes: minutes('CLAIM_TIMEOUT_SCAN_MINUTES', 5, 1),
  };
  if (problems.length > 0) {
    throw new Error(`Invalid worker environment: ${problems.join('; ')}`);
  }
  return config;
}
