import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { RecentLogsInputSchema } from '@compass/contracts';
import { authedProcedure, publicProcedure, router } from '../trpc';
import { logger } from '../../infra/log';
import { checkRate } from '../../services/rateLimit';

/**
 * Rate limit for the public `system.log` endpoint (M1.9 hardening,
 * 2026-05-07). The endpoint accepts up to 200 events per call,
 * unauthenticated, and writes to `ops.client_logs` plus mirrors to
 * pino — without a cap, anyone could flood disk + drown structured-log
 * signal. 60 calls/min/IP comfortably covers the legitimate batched
 * client (FE flushes every ~5s when active, way under the cap) while
 * cutting off attacker volume by ~3 orders of magnitude. We don't
 * limit by event count because honest spikes (e.g. an error storm in
 * the WebView) legitimately fill a single batch to the 200 cap.
 *
 * Same null-IP fallback as auth.ts: if Cloudflare/proxy headers don't
 * yield an IP we don't enforce — the alternative is dropping all
 * client telemetry behind a misconfigured proxy, which would blind us
 * during incidents.
 */
const LOG_LIMIT = { window: 60_000, max: 60 } as const;

/**
 * Lenient batch shape. We accept anything that has an `events` array,
 * normalize each event ourselves, and clamp/drop fields that don't fit
 * our DB columns. The strict ClientLogEventSchema is preserved in
 * @compass/contracts for typing the FE writer; the server, by contrast,
 * is forgiving so a stale FE bundle with a slightly different shape
 * still gets ingested instead of 400-looping into oblivion.
 */
const LooseLogBatchSchema = z.object({
  events: z.array(z.record(z.unknown())).max(200),
});

const ALLOWED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}

export const systemRouter = router({
  /**
   * Health probe (M1.16, 2026-05-08): now actually checks reality.
   *
   * Returns:
   *   - status: 'ok' | 'degraded'    (degraded = something to look at)
   *   - db: did SELECT 1 succeed
   *   - outboxPending: rows in sync.outbox awaiting delivery
   *   - outboxOldestSec: age in seconds of the oldest unsent row.
   *     High value = worker stalled, network egress dead, or backoff
   *     exhausted. Threshold for "degraded" is 300s (5 min) — covers
   *     normal retry windows (5/10/30/60s) without flapping.
   *
   * The check is intentionally lightweight (two cheap COUNT/MAX
   * queries) so deploy.ts smoke can poll it without load impact.
   */
  health: publicProcedure.query(async ({ ctx }) => {
    let dbOk = true;
    let outboxPending = 0;
    let outboxOldestSec: number | null = null;
    try {
      await ctx.db.execute(sql`SELECT 1`);
    } catch (err) {
      logger.error({ err }, 'system.health: db ping failed');
      dbOk = false;
    }
    if (dbOk) {
      try {
        const r = (await ctx.db.execute(sql`
          SELECT
            COUNT(*)::int AS pending,
            EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_sec
          FROM sync.outbox
          WHERE sent_at IS NULL
        `)) as unknown as Array<{ pending: number; oldest_sec: number | null }>;
        outboxPending = r[0]?.pending ?? 0;
        outboxOldestSec = r[0]?.oldest_sec ?? null;
      } catch (err) {
        logger.warn({ err }, 'system.health: outbox probe failed');
      }
    }
    const degraded =
      !dbOk || (outboxOldestSec !== null && outboxOldestSec > 300);
    // M3.8 (2026-05-15): `redis` was previously a hardcoded `true` in
    // the response, but no Redis client is ever instantiated in the
    // codebase. ioredis is in package.json + REDIS_URL is reserved in
    // env.ts as future-proofing (hub.ts comments mention M2 swapping
    // to Redis pub/sub), but until that lands we don't pretend the
    // field is meaningful. Dropped to stop misleading the
    // DebugPage / monitoring dashboards.
    return {
      status: degraded ? ('degraded' as const) : ('ok' as const),
      db: dbOk,
      projectorLag: 0,
      outboxPending,
      outboxOldestSec,
      version: process.env.VITE_BUILD_SHA ?? 'dev',
    };
  }),

  /**
   * Public app config. Exposes a few server-side env values the web
   * bundle needs (chiefly the Telegram bot username for invite share
   * links). Cached aggressively on the client side; refreshed on
   * deploys via the version-check toast.
   */
  appConfig: publicProcedure.query(() => ({
    botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null,
  })),

  /**
   * Client telemetry ingestion. Anonymous-friendly so unauth'd events still flow.
   * Uses a lenient input schema so a stale FE bundle never gets stuck in a
   * 400-loop. Each event is normalized + length-clamped per `ops.client_logs`
   * column constraints; rejects are counted but don't fail the batch.
   */
  log: publicProcedure.input(LooseLogBatchSchema).mutation(async ({ ctx, input }) => {
    if (ctx.ip && !checkRate('system.log', ctx.ip, LOG_LIMIT)) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'system.errors.logRateLimited',
      });
    }
    const orgId = ctx.session?.orgId ?? null;
    const userId = ctx.session?.userId ?? null;

    const rows: Array<typeof s.clientLogs.$inferInsert> = [];
    let dropped = 0;
    for (const raw of input.events) {
      const sessionId = clamp(raw.sessionId, 64);
      const level = typeof raw.level === 'string' && ALLOWED_LEVELS.has(raw.level)
        ? (raw.level as 'debug' | 'info' | 'warn' | 'error')
        : 'info';
      const kind = clamp(raw.kind, 32);
      if (!sessionId || !kind) {
        dropped++;
        continue;
      }
      const clientTs = typeof raw.clientTs === 'number' ? Math.floor(raw.clientTs) : Date.now();
      rows.push({
        orgId,
        userId,
        sessionId,
        level,
        kind,
        action: clamp(raw.action, 64),
        target: clamp(raw.target, 200),
        data: (raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : null),
        errorMsg: typeof raw.errorMsg === 'string' ? raw.errorMsg.slice(0, 4000) : null,
        errorStack: typeof raw.errorStack === 'string' ? raw.errorStack.slice(0, 8000) : null,
        platform: clamp(raw.platform, 32),
        appVersion: clamp(raw.appVersion, 32),
        traceId: clamp(raw.traceId, 64),
        spanId: clamp(raw.spanId, 32),
        clientTs,
      });
    }

    if (rows.length > 0) {
      await ctx.db.insert(s.clientLogs).values(rows);
    }

    // Mirror to pino so they show in `journalctl -u compass-api`.
    for (const r of rows) {
      const lvl = r.level as 'debug' | 'info' | 'warn' | 'error';
      logger[lvl](
        {
          kind: r.kind,
          action: r.action,
          target: r.target,
          errorMsg: r.errorMsg,
          orgId: r.orgId,
          userId: r.userId,
          sessionId: r.sessionId,
          data: r.data,
        },
        'client_log',
      );
    }

    return { accepted: rows.length, dropped };
  }),

  recentLogs: authedProcedure.input(RecentLogsInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      return tx.query.clientLogs.findMany({
        where: (cl, { eq, and }) =>
          input.userId
            ? and(eq(cl.orgId, ctx.session!.orgId), eq(cl.userId, input.userId))
            : eq(cl.orgId, ctx.session!.orgId),
        orderBy: (cl, { desc }) => desc(cl.createdAt),
        limit: input.limit,
      });
    });
  }),
});
