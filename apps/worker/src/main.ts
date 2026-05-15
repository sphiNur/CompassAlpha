/**
 * Worker — periodic + queue-driven jobs.
 *
 * Currently runs:
 *   - outbox.flush — every 5 s, drains sync.outbox via grammY (bot).
 *                    Marks rows sent_at = now() on success, bumps retries +
 *                    nextAttemptAt exponentially on failure.
 *
 * Future (M2/M3):
 *   - supplier.rescore           every 5 m
 *   - eod.archive                daily 00:00 org-tz
 *   - reports.daily              daily 01:00 org-tz
 *   - priceAlert.detect          daily 01:30
 *
 * Config via env (loaded server-side from compass-alpha/.env):
 *   DATABASE_URL          required
 *   TELEGRAM_BOT_TOKEN    optional; if missing, bot dispatch logs and skips
 *   FRONTEND_URL          optional; used as base for deep-link buttons
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { Bot, GrammyError, HttpError } from 'grammy';
import { getDb, schema as s, closeDb } from '@compass/db';

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

const FLUSH_INTERVAL_MS = 5_000;
const MAX_RETRIES = 8;
// Exponential backoff: 5 s, 10 s, 30 s, 1 min, 5 min, 15 min, 1 h, 3 h
const BACKOFF_SECONDS = [5, 10, 30, 60, 300, 900, 3600, 10_800];

const db = getDb(process.env.DATABASE_URL);
const botToken = process.env.TELEGRAM_BOT_TOKEN;
/**
 * Kill-switch added 2026-05-05.
 *
 * The production server cannot reach api.telegram.org from its egress
 * (regional network policy — `curl -v https://api.telegram.org` times
 * out). Without this switch, the worker would retry every 5 s and the
 * journal would fill with `Network request for 'sendMessage' failed!`.
 *
 * **Default flipped to `false` for M0** — bot rows get marked sent with
 * a `lastError: 'bot delivery disabled'` note so the queue drains and
 * the log is quiet. To re-enable (M2, after we ship a SOCKS proxy or
 * move the bot to a host that can reach Telegram), set
 * `BOT_DELIVERY_ENABLED=true` in the server `.env`.
 *
 * This is the SAFE default for any deploy where Telegram reachability
 * isn't proven — operators don't get notifications, but the system
 * stays healthy. Mini App in-product UX is unaffected (it doesn't
 * depend on outbound bot messages).
 */
const botDeliveryEnabled =
  (process.env.BOT_DELIVERY_ENABLED ?? 'false').toLowerCase() === 'true';
const bot = botToken && botDeliveryEnabled ? new Bot(botToken) : null;

if (!bot) {
  if (!botToken) {
    console.warn('[worker] TELEGRAM_BOT_TOKEN missing — bot dispatch will be a no-op.');
  } else if (!botDeliveryEnabled) {
    console.warn(
      '[worker] BOT_DELIVERY_ENABLED=false — outbox bot rows will be marked sent without delivery.',
    );
  }
}

interface OutboxPayload {
  orgId: string;
  recipientUserId: string;
  template: string;
  title: string;
  body?: string;
  deepLink?: string;
  dedupKey?: string;
  extra?: Record<string, unknown>;
}

/**
 * Drain up to 50 pending outbox rows.
 *
 * M1.22 (2026-05-08, launch hardening): each row gets its own
 * `SELECT ... FOR UPDATE SKIP LOCKED` so:
 *
 *   1. A future second worker (we run one today, but the API can
 *      scale) won't double-process — the row lock is exclusive
 *      within the picking tx.
 *   2. A crash mid-batch limits the blast radius to the ONE row
 *      currently held. Previously the loop kept 50 rows in memory
 *      without per-row commits, so a crash on row 23 could leave
 *      0–22 marked sent + the rest in limbo.
 *   3. The lock is released when the tx commits or the connection
 *      drops; an OS-kill leaves no permanently-stuck rows.
 *
 * Note: the bot HTTP send happens AFTER the lock is acquired but
 * BEFORE the tx commits. If the worker crashes between bot send and
 * commit, the user gets a duplicate message on the next retry —
 * acceptable for "important" notifications (at-least-once delivery)
 * and the dedup_key on notifications already de-dupes the user-
 * facing record.
 */
async function processOnce(): Promise<{ sent: number; deferred: number; failed: number }> {
  let sent = 0;
  let deferred = 0;
  let failed = 0;

  // Loop one row at a time, each in its own tx, until SKIP LOCKED
  // returns nothing (queue drained for this pass) or we hit 50.
  for (let i = 0; i < 50; i++) {
    const claimed = await db.transaction(async (tx) => {
      // Atomic claim: pick the oldest unsent row that's due, locking
      // it so concurrent workers skip it. Order by created_at for
      // FIFO fairness — older notifications go out first.
      const rows = (await tx.execute(sql`
        SELECT id, channel, payload, retries
        FROM sync.outbox
        WHERE sent_at IS NULL
          AND next_attempt_at <= NOW()
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `)) as unknown as Array<{
        id: string;
        channel: string;
        payload: unknown;
        retries: number;
      }>;
      const row = rows[0];
      if (!row) return null;

      const now = new Date();

      if (row.channel === 'bot') {
        if (!bot) {
          await tx
            .update(s.outbox)
            .set({ sentAt: now, lastError: 'bot delivery disabled' })
            .where(eq(s.outbox.id, row.id));
          return 'sent' as const;
        }
        const ok = await deliverBot(row.payload as OutboxPayload);
        if (ok) {
          await tx.update(s.outbox).set({ sentAt: now }).where(eq(s.outbox.id, row.id));
          return 'sent' as const;
        }
        await deferOutboxTx(tx, row.id, row.retries);
        return 'deferred' as const;
      }
      if (row.channel === 'webpush') {
        await tx
          .update(s.outbox)
          .set({ sentAt: now, lastError: 'webpush not implemented (M2)' })
          .where(eq(s.outbox.id, row.id));
        return 'failed' as const;
      }
      await tx
        .update(s.outbox)
        .set({ sentAt: now, lastError: `unknown channel "${row.channel}"` })
        .where(eq(s.outbox.id, row.id));
      return 'failed' as const;
    });

    if (!claimed) break; // queue drained for this pass
    if (claimed === 'sent') sent++;
    else if (claimed === 'deferred') deferred++;
    else failed++;
  }
  return { sent, deferred, failed };
}

async function deliverBot(payload: OutboxPayload): Promise<boolean> {
  if (!bot) return false;
  const user = await db.query.users.findFirst({
    where: (u, { eq: eq2 }) => eq2(u.id, payload.recipientUserId),
  });
  if (!user || !user.tgUserId) {
    console.warn('[worker] bot dispatch: no tgUserId for user', payload.recipientUserId);
    return true; // mark sent — without a TG id we can never deliver, don't loop.
  }

  const text = payload.body
    ? `*${escapeMd(payload.title)}*\n${escapeMd(payload.body)}`
    : `*${escapeMd(payload.title)}*`;

  try {
    await bot.api.sendMessage(Number(user.tgUserId), text, {
      parse_mode: 'MarkdownV2',
      ...(payload.deepLink
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: 'Open Compass',
                    web_app: { url: resolveDeepLink(payload.deepLink) },
                  },
                ],
              ],
            },
          }
        : {}),
    });
    return true;
  } catch (err) {
    if (err instanceof GrammyError) {
      // Permanent errors (user blocked bot, invalid id) → mark sent so we
      // don't retry endlessly.
      if (err.error_code === 403 || err.error_code === 400) {
        console.warn('[worker] permanent bot error', err.error_code, err.description);
        return true;
      }
    }
    if (err instanceof HttpError) {
      console.warn('[worker] transient bot error', err.message);
    } else {
      console.error('[worker] unknown bot error', err);
    }
    return false;
  }
}

/**
 * Tx-scoped variant — used inside processOnce's per-row transaction
 * (M1.22). Same logic as the original; just takes a tx handle instead
 * of using the module-level db.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function deferOutboxTx(
  tx: Tx,
  id: string,
  currentRetries: number,
): Promise<void> {
  const next = currentRetries + 1;
  if (next >= MAX_RETRIES) {
    await tx
      .update(s.outbox)
      .set({ sentAt: new Date(), lastError: `gave up after ${MAX_RETRIES} retries` })
      .where(eq(s.outbox.id, id));
    return;
  }
  const delay = BACKOFF_SECONDS[Math.min(next, BACKOFF_SECONDS.length - 1)]!;
  await tx
    .update(s.outbox)
    .set({
      retries: next,
      nextAttemptAt: sql`now() + ${delay}::int * interval '1 second'`,
    })
    .where(eq(s.outbox.id, id));
}

function escapeMd(text: string): string {
  // MarkdownV2 reserved characters per
  // https://core.telegram.org/bots/api#markdownv2-style
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function resolveDeepLink(path: string): string {
  const base = process.env.FRONTEND_URL?.replace(/\/$/, '') ?? '';
  if (path.startsWith('http')) return path;
  if (!base) return path;
  return base + (path.startsWith('/') ? path : '/' + path);
}

let stopped = false;
// Heartbeat cadence — long enough to be quiet in journal at idle,
// short enough that deploy-time smoke + on-call greps both find a
// recent line. Independent of queue activity (the `flushed:` line
// only logs when there's actual work).
const HEARTBEAT_MS = 60_000;
let lastHeartbeat = Date.now();

// M3.8 (2026-05-15): idempotency_keys cleanup cadence — once an hour.
// The idempotency middleware caches a 24h TTL response per (key,
// route, user). The table grows linearly with mutation volume and
// has no cleanup elsewhere, so without this it would silently bloat
// over months (a busy chain at 10k mutations / day = 240k rows after
// the first month, fine; 2.4 M after a year, still fine; but the
// expires_at index would carry stale rows forever). Cleaning hourly
// keeps the working set at roughly 24h × mutation-rate.
const IDEMPOTENCY_CLEANUP_MS = 60 * 60 * 1000;
let lastIdempotencyCleanup = Date.now();

async function cleanupIdempotencyKeys(): Promise<number> {
  // Delete every row whose expires_at is in the past. The index
  // idem_expires_idx makes this O(matches) not O(table). The DELETE
  // returns deleted rows so we can log a one-line summary.
  const r = (await db.execute(sql`
    DELETE FROM sync.idempotency_keys
    WHERE expires_at < NOW()
    RETURNING key
  `)) as unknown as Array<{ key: string }>;
  return r.length;
}

async function loop() {
  while (!stopped) {
    try {
      const r = await processOnce();
      if (r.sent || r.deferred || r.failed) {
        console.log(`[worker] flushed: sent=${r.sent} deferred=${r.deferred} failed=${r.failed}`);
      }
      // Heartbeat regardless of queue activity. Lets post-deploy smoke
      // verify the loop is alive even when the outbox is empty (M1.9).
      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        console.log('[worker] heartbeat');
        lastHeartbeat = Date.now();
      }
      // Idempotency keys cleanup. Hourly cadence; failure logs but
      // doesn't break the outer loop — next attempt picks up rows
      // that were not deleted on the prior failure.
      if (Date.now() - lastIdempotencyCleanup >= IDEMPOTENCY_CLEANUP_MS) {
        try {
          const deleted = await cleanupIdempotencyKeys();
          if (deleted > 0) {
            console.log(`[worker] idempotency cleanup: ${deleted} expired keys deleted`);
          }
        } catch (err) {
          console.error('[worker] idempotency cleanup failed', err);
        }
        lastIdempotencyCleanup = Date.now();
      }
    } catch (err) {
      console.error('[worker] processOnce threw', err);
    }
    await new Promise((resolve) => setTimeout(resolve, FLUSH_INTERVAL_MS));
  }
}

const shutdown = async (signal: string) => {
  console.log(`[worker] shutdown (${signal})`);
  stopped = true;
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log('[worker] online · outbox flush every', FLUSH_INTERVAL_MS, 'ms');
void loop();
