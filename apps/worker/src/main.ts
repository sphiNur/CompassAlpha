/**
 * Worker — periodic + queue-driven jobs.
 *
 * Currently runs:
 *   - outbox.flush — every 5 s, drains sync.outbox via either a Cloudflare
 *                    Worker relay or direct grammY. See bot dispatch block
 *                    below for transport selection.
 *
 * Future (M2/M3):
 *   - supplier.rescore           every 5 m
 *   - eod.archive                daily 00:00 org-tz
 *   - reports.daily              daily 01:00 org-tz
 *   - priceAlert.detect          daily 01:30
 *
 * Config via env (loaded server-side from compass-alpha/.env):
 *   DATABASE_URL          required
 *   TELEGRAM_BOT_TOKEN    optional; needed only for direct grammY transport
 *   TG_RELAY_URL          optional; CF Worker relay URL (see infra/cloudflare/)
 *   COMPASS_RELAY_KEY     optional; shared secret matching the relay
 *   BOT_DELIVERY_ENABLED  optional override; see bot dispatch block
 *   FRONTEND_URL          optional; used as base for deep-link buttons
 */
import { randomUUID } from 'node:crypto';
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

/**
 * Bot dispatch — two transports, configured by env.
 *
 * Origin of this complexity: the production server cannot reach
 * api.telegram.org from its egress (regional network policy —
 * `curl -v https://api.telegram.org` times out). Direct grammY would
 * retry every 5 s and flood the journal with timeouts (incident
 * 2026-05-05). So we added a Cloudflare Worker relay that runs on
 * Cloudflare's edge and forwards to Telegram (see
 * `infra/cloudflare/tg-relay.js`).
 *
 * Transport selection:
 *   1. Relay path — set both `TG_RELAY_URL` and `COMPASS_RELAY_KEY`.
 *      Used in production (blocked egress). Default-on when both
 *      vars are set.
 *   2. Direct grammY — set only `TELEGRAM_BOT_TOKEN`. Used where the
 *      host can reach api.telegram.org. Default-off; operator must
 *      set `BOT_DELIVERY_ENABLED=true` to affirm reachability.
 *
 * `BOT_DELIVERY_ENABLED=false` explicitly disables either transport
 * (dev / test envs). Bot outbox rows get marked sent with a note so
 * the queue drains and the log stays quiet.
 *
 * Mini App in-product UX is unaffected when delivery is off — operators
 * just don't get Telegram pushes.
 */
const relayUrl = process.env.TG_RELAY_URL;
const relayKey = process.env.COMPASS_RELAY_KEY;
const relayConfigured = !!(relayUrl && relayKey);
const botToken = process.env.TELEGRAM_BOT_TOKEN;

const explicitDeliveryToggle = process.env.BOT_DELIVERY_ENABLED?.toLowerCase();
const botDeliveryEnabled =
  explicitDeliveryToggle === undefined ? relayConfigured : explicitDeliveryToggle === 'true';

// grammY only when no relay is configured — relay path uses plain fetch.
const bot =
  botDeliveryEnabled && !relayConfigured && botToken ? new Bot(botToken) : null;

if (!botDeliveryEnabled) {
  console.warn(
    '[worker] bot delivery disabled — outbox bot rows will be marked sent without delivery.',
  );
} else if (relayConfigured) {
  console.log(`[worker] bot delivery via CF Worker relay (${relayUrl})`);
} else if (bot) {
  console.log('[worker] bot delivery via direct grammY (api.telegram.org)');
} else {
  console.warn(
    '[worker] BOT_DELIVERY_ENABLED=true but no transport configured ' +
      '(need either TG_RELAY_URL+COMPASS_RELAY_KEY or TELEGRAM_BOT_TOKEN). ' +
      'Outbox bot rows will be marked sent without delivery.',
  );
}

class RelayError extends Error {
  constructor(
    public errorCode: number,
    public description: string,
  ) {
    super(`relay ${errorCode}: ${description}`);
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
        const canDeliver = botDeliveryEnabled && (relayConfigured || !!bot);
        if (!canDeliver) {
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
  if (!botDeliveryEnabled) return false;
  const user = await db.query.users.findFirst({
    where: (u, { eq: eq2 }) => eq2(u.id, payload.recipientUserId),
  });
  if (!user || !user.tgUserId) {
    console.warn('[worker] bot dispatch: no tgUserId for user', payload.recipientUserId);
    return true; // mark sent — without a TG id we can never deliver, don't loop.
  }

  const chatId = Number(user.tgUserId);
  const text = payload.body
    ? `*${escapeMd(payload.title)}*\n${escapeMd(payload.body)}`
    : `*${escapeMd(payload.title)}*`;
  const opts: Record<string, unknown> = {
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
  };

  try {
    if (relayConfigured) {
      await sendViaRelay(chatId, text, opts);
    } else if (bot) {
      await bot.api.sendMessage(chatId, text, opts);
    } else {
      return false;
    }
    return true;
  } catch (err) {
    // Permanent errors (user blocked bot, invalid id, bad request) → mark
    // sent so we don't retry endlessly. Anything else is transient.
    if (err instanceof RelayError) {
      if (err.errorCode === 403 || err.errorCode === 400) {
        console.warn('[worker] permanent relay error', err.errorCode, err.description);
        return true;
      }
      console.warn('[worker] transient relay error', err.message);
      return false;
    }
    if (err instanceof GrammyError) {
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
 * Forward a sendMessage call through the Cloudflare Worker relay.
 *
 * The relay's contract: POST `{ method, params }` with the shared-secret
 * header; the relay returns the Bot API JSON verbatim. We unwrap that
 * and translate failure modes into RelayError so deliverBot can decide
 * permanent vs transient.
 */
async function sendViaRelay(
  chatId: number,
  text: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(relayUrl!, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-compass-key': relayKey!,
    },
    body: JSON.stringify({
      method: 'sendMessage',
      params: { chat_id: chatId, text, ...opts },
    }),
  });

  type RelayBody = { ok?: boolean; error_code?: number; description?: string };
  let body: RelayBody | null = null;
  try {
    body = (await res.json()) as RelayBody;
  } catch {
    // Response wasn't JSON — caller treats as transient.
    throw new RelayError(res.status, `non-json relay response (http ${res.status})`);
  }

  // 5xx from CF / Telegram → transient.
  if (res.status >= 500) {
    throw new RelayError(res.status, body?.description ?? `http ${res.status}`);
  }
  // 4xx from the relay itself (forbidden, bad method) → treat as transient
  // unless it matches a known permanent Bot API code.
  if (!res.ok) {
    throw new RelayError(res.status, body?.description ?? `http ${res.status}`);
  }
  // Bot API said no.
  if (body?.ok === false) {
    throw new RelayError(body.error_code ?? 0, body.description ?? 'unknown bot api error');
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

// M3.20 (2026-05-18): claim-timeout cadence + threshold. The take-over
// button (M3.19) needs a human watching the queue. This task is the
// system-level safety net for unattended deployments — if a claimer
// goes idle, the order returns to the queue automatically so the
// next approver can pick it up without manual intervention.
//
//   CLAIM_TIMEOUT_MINUTES         — how long a claim sits before
//                                   counting as stale (default 30)
//   CLAIM_TIMEOUT_SCAN_MINUTES    — how often this worker scans
//                                   for stale claims (default 5)
//
// Set CLAIM_TIMEOUT_MINUTES=0 to disable the auto-release task.
const CLAIM_TIMEOUT_MINUTES = parseInt(process.env.CLAIM_TIMEOUT_MINUTES ?? '30', 10);
const CLAIM_TIMEOUT_SCAN_MS =
  parseInt(process.env.CLAIM_TIMEOUT_SCAN_MINUTES ?? '5', 10) * 60_000;
let lastClaimTimeoutScan = Date.now();

if (CLAIM_TIMEOUT_MINUTES > 0) {
  console.log(
    `[worker] claim auto-release: scan every ${CLAIM_TIMEOUT_SCAN_MS / 60_000}m, ` +
      `release after ${CLAIM_TIMEOUT_MINUTES}m idle`,
  );
} else {
  console.warn('[worker] claim auto-release disabled (CLAIM_TIMEOUT_MINUTES=0)');
}

/**
 * Find sessions whose claim has sat idle past CLAIM_TIMEOUT_MINUTES and
 * release them by appending a `ClaimReleased{reason:'timeout'}` event +
 * updating the read model. Each release runs in its own tx with FOR UPDATE
 * so a concurrent approve/reject/manual-release races cleanly: only one
 * winner inserts seq=N+1; the other tx sees an updated last_seq and skips.
 *
 * No human actor → event payload has `byMemberId: null`. The audit log
 * groups these with override releases under "interventions" (M3.21).
 */
async function releaseStaleClaims(): Promise<number> {
  if (CLAIM_TIMEOUT_MINUTES <= 0) return 0;

  // Candidate set first — cheap scan, no locks.
  const candidates = (await db.execute(sql`
    SELECT id, org_id, last_seq, claimed_by_member_id, claimed_at
    FROM read_model.order_sessions_v
    WHERE status = 'submitted'
      AND claimed_by_member_id IS NOT NULL
      AND claimed_at < NOW() - (${CLAIM_TIMEOUT_MINUTES}::int * interval '1 minute')
    ORDER BY claimed_at
    LIMIT 100
  `)) as unknown as Array<{
    id: string;
    org_id: string;
    last_seq: number;
    claimed_by_member_id: string;
    claimed_at: Date;
  }>;
  if (candidates.length === 0) return 0;

  let released = 0;
  for (const row of candidates) {
    try {
      const ok = await db.transaction(async (tx) => {
        // Re-check under row lock — another tx may have already
        // approved / rejected / manually released between our SELECT
        // and now. If so, just skip.
        const fresh = (await tx.execute(sql`
          SELECT last_seq, claimed_by_member_id, claimed_at, status
          FROM read_model.order_sessions_v
          WHERE id = ${row.id}
          FOR UPDATE
        `)) as unknown as Array<{
          last_seq: number;
          claimed_by_member_id: string | null;
          claimed_at: Date | null;
          status: string;
        }>;
        const cur = fresh[0];
        if (!cur) return false;
        if (
          cur.status !== 'submitted' ||
          cur.claimed_by_member_id === null ||
          cur.claimed_at === null ||
          cur.claimed_at.getTime() >= Date.now() - CLAIM_TIMEOUT_MINUTES * 60_000
        ) {
          return false;
        }
        const newSeq = cur.last_seq + 1;
        const occurredAt = new Date();
        // Append the timeout event. Schema invariant: (stream_id, seq)
        // is uniqueIndex'd so a racing append would error out here —
        // we let the tx fail and move on rather than retrying.
        await tx.insert(s.events).values({
          id: randomUUID(),
          orgId: row.org_id,
          streamType: 'order',
          streamId: row.id,
          seq: newSeq,
          type: 'ClaimReleased',
          payload: { byMemberId: null, reason: 'timeout' },
          actorId: null,
          occurredAt,
          correlationId: null,
          causationId: null,
          idempotencyKey: null,
        });
        // Mirror the projector's ClaimReleased branch (M3.22): snapshot
        // the timed-out claimer into previous_claimer_member_id so the
        // next reviewer's banner shows "X → Y".
        await tx
          .update(s.orderSessionsV)
          .set({
            claimedByMemberId: null,
            claimedAt: null,
            previousClaimerMemberId: cur.claimed_by_member_id,
            lastSeq: newSeq,
            updatedAt: occurredAt,
          })
          .where(eq(s.orderSessionsV.id, row.id));
        return true;
      });
      if (ok) {
        released++;
        console.log(
          `[worker] claim timeout released: session=${row.id} prevClaimer=${row.claimed_by_member_id} idleFor=${Math.round((Date.now() - row.claimed_at.getTime()) / 60_000)}m`,
        );
      }
    } catch (err) {
      // Lost a race with a concurrent approval / manual release / another
      // worker — projection is still consistent, just log and continue.
      console.error('[worker] release-stale-claim failed for', row.id, err);
    }
  }
  return released;
}

/**
 * Sister of `releaseStaleClaims`: same CLAIM_TIMEOUT_MINUTES knob,
 * applied to `read_model.market_runs_v` for the C.2 (M3.38, 2026-05-19)
 * run-level claim. Mirrors the order sweep shape exactly — the
 * differences are the table, the event stream type ('run'), and the
 * status filter (runs are claimable in planned/purchasing/delivering;
 * finished/cancelled aren't candidates anyway because the projection
 * NULLs out claim columns at those terminal transitions).
 */
async function releaseStaleRunClaims(): Promise<number> {
  if (CLAIM_TIMEOUT_MINUTES <= 0) return 0;
  const candidates = (await db.execute(sql`
    SELECT id, org_id, last_seq, claimed_by_member_id, claimed_at
    FROM read_model.market_runs_v
    WHERE status IN ('planned', 'purchasing', 'delivering')
      AND claimed_by_member_id IS NOT NULL
      AND claimed_at < NOW() - (${CLAIM_TIMEOUT_MINUTES}::int * interval '1 minute')
    ORDER BY claimed_at
    LIMIT 100
  `)) as unknown as Array<{
    id: string;
    org_id: string;
    last_seq: number;
    claimed_by_member_id: string;
    claimed_at: Date;
  }>;
  if (candidates.length === 0) return 0;

  let released = 0;
  for (const row of candidates) {
    try {
      const ok = await db.transaction(async (tx) => {
        const fresh = (await tx.execute(sql`
          SELECT last_seq, claimed_by_member_id, claimed_at, status
          FROM read_model.market_runs_v
          WHERE id = ${row.id}
          FOR UPDATE
        `)) as unknown as Array<{
          last_seq: number;
          claimed_by_member_id: string | null;
          claimed_at: Date | null;
          status: string;
        }>;
        const cur = fresh[0];
        if (!cur) return false;
        if (
          (cur.status !== 'planned' &&
            cur.status !== 'purchasing' &&
            cur.status !== 'delivering') ||
          cur.claimed_by_member_id === null ||
          cur.claimed_at === null ||
          cur.claimed_at.getTime() >= Date.now() - CLAIM_TIMEOUT_MINUTES * 60_000
        ) {
          return false;
        }
        const newSeq = cur.last_seq + 1;
        const occurredAt = new Date();
        await tx.insert(s.events).values({
          id: randomUUID(),
          orgId: row.org_id,
          streamType: 'run',
          streamId: row.id,
          seq: newSeq,
          type: 'RunClaimReleased',
          payload: { byMemberId: null, reason: 'timeout' },
          actorId: null,
          occurredAt,
          correlationId: null,
          causationId: null,
          idempotencyKey: null,
        });
        await tx
          .update(s.marketRunsV)
          .set({
            claimedByMemberId: null,
            claimedAt: null,
            previousClaimerMemberId: cur.claimed_by_member_id,
            lastSeq: newSeq,
            updatedAt: occurredAt,
          })
          .where(eq(s.marketRunsV.id, row.id));
        return true;
      });
      if (ok) {
        released++;
        console.log(
          `[worker] run claim timeout released: run=${row.id} prevClaimer=${row.claimed_by_member_id} idleFor=${Math.round((Date.now() - row.claimed_at.getTime()) / 60_000)}m`,
        );
      }
    } catch (err) {
      console.error('[worker] release-stale-run-claim failed for', row.id, err);
    }
  }
  return released;
}

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
      // M3.20: claim-timeout sweep — see releaseStaleClaims() above.
      // C.2 (M3.38): same cadence now also sweeps run-level claims via
      // releaseStaleRunClaims. Both share CLAIM_TIMEOUT_MINUTES.
      if (
        CLAIM_TIMEOUT_MINUTES > 0 &&
        Date.now() - lastClaimTimeoutScan >= CLAIM_TIMEOUT_SCAN_MS
      ) {
        try {
          const releasedOrders = await releaseStaleClaims();
          if (releasedOrders > 0) {
            console.log(
              `[worker] order claim timeout sweep: ${releasedOrders} stale claim(s) released`,
            );
          }
        } catch (err) {
          console.error('[worker] order claim timeout sweep failed', err);
        }
        try {
          const releasedRuns = await releaseStaleRunClaims();
          if (releasedRuns > 0) {
            console.log(
              `[worker] run claim timeout sweep: ${releasedRuns} stale claim(s) released`,
            );
          }
        } catch (err) {
          console.error('[worker] run claim timeout sweep failed', err);
        }
        lastClaimTimeoutScan = Date.now();
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
