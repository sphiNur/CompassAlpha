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
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
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

async function processOnce(): Promise<{ sent: number; deferred: number; failed: number }> {
  const now = new Date();
  const pending = await db
    .select()
    .from(s.outbox)
    .where(and(isNull(s.outbox.sentAt), lte(s.outbox.nextAttemptAt, now)))
    .limit(50);

  let sent = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of pending) {
    if (row.channel === 'bot') {
      // Kill-switch path — bot delivery off (e.g. egress to Telegram
      // blocked). Mark row sent so the queue drains; record `lastError`
      // so post-mortems show the rows weren't really delivered.
      if (!bot) {
        await db
          .update(s.outbox)
          .set({ sentAt: now, lastError: 'bot delivery disabled' })
          .where(eq(s.outbox.id, row.id));
        sent++;
        continue;
      }
      const ok = await deliverBot(row.payload as OutboxPayload);
      if (ok) {
        await db.update(s.outbox).set({ sentAt: now }).where(eq(s.outbox.id, row.id));
        sent++;
      } else {
        await deferOutbox(row.id, row.retries);
        deferred++;
      }
    } else if (row.channel === 'webpush') {
      // M2: implement WebPush delivery. Mark sent so the queue doesn't grow.
      await db
        .update(s.outbox)
        .set({ sentAt: now, lastError: 'webpush not implemented (M2)' })
        .where(eq(s.outbox.id, row.id));
      failed++;
    } else {
      await db
        .update(s.outbox)
        .set({ sentAt: now, lastError: `unknown channel "${row.channel}"` })
        .where(eq(s.outbox.id, row.id));
      failed++;
    }
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

async function deferOutbox(id: string, currentRetries: number): Promise<void> {
  const next = currentRetries + 1;
  if (next >= MAX_RETRIES) {
    await db
      .update(s.outbox)
      .set({ sentAt: new Date(), lastError: `gave up after ${MAX_RETRIES} retries` })
      .where(eq(s.outbox.id, id));
    return;
  }
  const delay = BACKOFF_SECONDS[Math.min(next, BACKOFF_SECONDS.length - 1)]!;
  await db
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
async function loop() {
  while (!stopped) {
    try {
      const r = await processOnce();
      if (r.sent || r.deferred || r.failed) {
        console.log(`[worker] flushed: sent=${r.sent} deferred=${r.deferred} failed=${r.failed}`);
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
