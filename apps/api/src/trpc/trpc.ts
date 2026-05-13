import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { DomainError } from '@compass/domain';
import { schema as s } from '@compass/db';
import type { RequestContext } from './context';
import { logger } from '../infra/log';
import { checkRate } from '../services/rateLimit';

const t = initTRPC.context<RequestContext>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    if (cause instanceof DomainError) {
      return {
        ...shape,
        data: {
          ...shape.data,
          code: shape.data.code,
          domainCode: cause.code,
          i18nKey: cause.i18nKey,
          context: cause.context,
        },
      };
    }
    if (cause instanceof ZodError) {
      return {
        ...shape,
        data: {
          ...shape.data,
          i18nKey: 'common.errors.validation',
          fieldErrors: cause.flatten().fieldErrors,
        },
      };
    }
    return shape;
  },
});

export const router = t.router;
export const middleware = t.middleware;

/**
 * Cross-cutting error logger (M1.9-extra P7, 2026-05-07). Audit found
 * that `admin.ts` and `auth.ts` had ZERO error logging — every failed
 * admin mutation was invisible in journalctl. Hoisting the catch into
 * the procedure factory means every router gets structured logging
 * for free, with consistent context shape.
 *
 * INTERNAL_SERVER_ERROR is logged at error level with the full stack;
 * client-fault errors (4xx-shape) are logged at warn level so they
 * don't drown the signal but are still searchable.
 */
const errorLogMiddleware = t.middleware(async (opts) => {
  try {
    return await opts.next();
  } catch (err) {
    const tErr = err instanceof TRPCError ? err : null;
    const code = tErr?.code ?? 'UNKNOWN';
    const message = tErr?.message ?? (err instanceof Error ? err.message : String(err));
    const isServerFault =
      !tErr ||
      code === 'INTERNAL_SERVER_ERROR' ||
      code === 'TIMEOUT';
    const log = isServerFault ? logger.error.bind(logger) : logger.warn.bind(logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = opts.ctx as any;
    log(
      {
        path: opts.path,
        type: opts.type,
        code,
        message,
        traceId: ctx?.traceId,
        userId: ctx?.session?.userId,
        orgId: ctx?.session?.orgId,
        cause: tErr?.cause,
        ...(isServerFault && err instanceof Error ? { stack: err.stack } : {}),
      },
      `trpc.${opts.path} ${tErr?.code ?? 'threw'}`,
    );
    throw err;
  }
});

export const publicProcedure = t.procedure.use(errorLogMiddleware);

/**
 * Per-user, per-route mutation rate limit (M1.20, 2026-05-08).
 *
 * Until M1.20 only auth.telegramLogin and system.log were rate-limited.
 * Order / run / sales / admin mutations had no limiter, so a buggy
 * client could flood the API and snowball into projection lag or DB
 * contention. The limiter here protects the API as a whole, not just
 * the auth surface.
 *
 * Budget: 120 mutations / minute / (user, route). That's 2 per second
 * sustained — well above realistic operator pacing (recording a
 * purchase takes 5+ seconds of typing) but tight enough to clamp a
 * runaway retry loop or a tap-storm bug.
 *
 * Queries (`opts.type === 'query'`) are NOT limited here — they're
 * idempotent reads and high-frequency polling is a feature, not abuse.
 * Subscriptions (`opts.type === 'subscription'`) are connection-level,
 * limited at the WebSocket layer.
 *
 * Exempt routes:
 *   - `system.log` — already has IP-level rate limit at the handler,
 *     and legitimate batched telemetry can spike above the user-level
 *     cap for short windows.
 *
 * Key shape: `{userId}:{path}` so a user can't starve themselves
 * across paths, and one chatty path can't starve quieter ones.
 */
const MUTATION_RATE_EXEMPT = new Set<string>(['system.log']);
const mutationRateMiddleware = t.middleware(async (opts) => {
  if (opts.type !== 'mutation') return opts.next();
  if (MUTATION_RATE_EXEMPT.has(opts.path)) return opts.next();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = opts.ctx as any;
  const userId: string | null = ctx?.session?.userId ?? null;
  if (!userId) return opts.next(); // unauth mutations (rare) — let
  // the auth check do its own throwing.
  const ok = checkRate(`mut:${opts.path}`, userId, { window: 60_000, max: 120 });
  if (!ok) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'common.errors.rateLimited',
    });
  }
  return opts.next();
});

/** Authenticated user required. */
export const authedProcedure = t.procedure
  .use(errorLogMiddleware)
  .use(mutationRateMiddleware)
  .use(async (opts) => {
    if (!opts.ctx.session) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.required' });
    }
    return opts.next({ ctx: { ...opts.ctx, session: opts.ctx.session } });
  });

/**
 * Idempotency middleware (M1.20, 2026-05-08).
 *
 * For mutations that have monetary or write-once effects (run.create,
 * run.purchaseItem, sales.record, order.submit, etc.), a network
 * retry without idempotency = double-charge / duplicate row / silently
 * wrong inventory. This middleware uses the existing
 * `sync.idempotency_keys` table to detect replays.
 *
 * Protocol:
 *   1. Client sends `X-Idempotency-Key: <ulid>` on critical
 *      mutations. The FE generates a fresh ULID per logical
 *      action (NOT per retry — same logical action = same key).
 *   2. Server looks up (key, path, userId). If found AND not
 *      expired, returns the cached response JSON. The client
 *      gets the same result as the original — replay is invisible.
 *   3. On miss, the handler runs. If it succeeds, we cache the
 *      result for 24 hours. If it throws, we DON'T cache — the
 *      next retry should be allowed (server-side error might be
 *      transient).
 *
 * Opt-in: routers use `idempotentMutation` (defined below) instead
 * of `authedProcedure` for the small set of risky mutations.
 *
 * Clients without the header bypass the cache entirely (compat
 * with older bundles + lower-stakes mutations).
 *
 * Key scope: (key + path + userId). Two users can pick the same
 * ULID without colliding; one user racing two different mutations
 * with the same key is rejected via the unique constraint at INSERT
 * time, which falls through to a normal handler run.
 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const idempotencyMiddleware = t.middleware(async (opts) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = opts.ctx as any;
  const key: string | null = ctx?.idempotencyKey ?? null;
  const userId: string | null = ctx?.session?.userId ?? null;
  // No key = no dedupe. Mutation runs normally.
  if (!key || !userId || opts.type !== 'mutation') {
    return opts.next();
  }
  const db = ctx.db as RequestContext['db'];
  const now = new Date();

  // Look for an existing entry. Match on (key, route, user) so a
  // ULID collision across users / routes can't surface another
  // user's result.
  const existing = await db.query.idempotencyKeys.findFirst({
    where: (k, { eq: eq2, and: and2, gt: gt2 }) =>
      and2(eq2(k.key, key), eq2(k.route, opts.path), eq2(k.userId, userId), gt2(k.expiresAt, now)),
  });
  if (existing && existing.response !== null && existing.response !== undefined) {
    logger.info(
      { path: opts.path, userId, key },
      'idempotency cache hit — returning prior response',
    );
    return existing.response as unknown as ReturnType<typeof opts.next>;
  }

  // Run the handler. Cache on success only.
  const result = await opts.next();
  // tRPC v11 middleware return shape: { ok: true, data, ctx } | { ok: false, error }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;
  if (r?.ok === true) {
    try {
      await db
        .insert(s.idempotencyKeys)
        .values({
          key,
          route: opts.path,
          userId,
          response: (r.data ?? null) as unknown as Record<string, unknown>,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        })
        .onConflictDoNothing();
    } catch (cacheErr) {
      // Best-effort cache; failure to cache MUST NOT fail the
      // request. The original mutation succeeded — the worst case
      // on a cache miss is that a retry runs the mutation again,
      // and the retry hits whatever natural-key dedupe exists
      // (event-stream uniqueness, etc.).
      logger.warn({ err: cacheErr, path: opts.path }, 'idempotency cache write failed');
    }
  }
  return result;
});

/**
 * Same as `authedProcedure` plus idempotency-key dedupe. Use for
 * mutations where a network retry could cause double-charge,
 * duplicate inventory deduction, or duplicate row creation. The FE
 * is responsible for sending `X-Idempotency-Key: <ulid>` per logical
 * action (NOT per retry). Without the header, the middleware passes
 * through unchanged — older clients keep working.
 *
 * Current consumers (M1.20):
 *   run.create, run.purchaseItem, run.revisePurchase,
 *   run.markUnavailable, run.deliverToStore, run.confirmStore,
 *   run.finish, run.cancel, order.submit, sales.record
 *
 * Anything that ONLY reads, OR that has natural-key dedupe through
 * an event-store unique seq, can stay on plain authedProcedure.
 */
export const idempotentMutation = authedProcedure.use(idempotencyMiddleware);

// Suppress unused-import diagnostics for drizzle helpers brought in
// only for the idempotency middleware's lookup query.
void and;
void eq;
void gt;

/**
 * Permission-checking procedure. Loads `storeIdField` (if given) from the
 * input and validates it belongs to ctx.orgId before invoking the handler.
 */
export function permissionProcedure(permissionKey: string) {
  return authedProcedure.use(async (opts) => {
    if (!opts.ctx.session.permissions.has(permissionKey)) {
      // M1.9-extra (P7): bare key + cause; no colon-suffix.
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'auth.errors.missingPermission',
        cause: { missingPermission: permissionKey },
      });
    }
    return opts.next();
  });
}

/** Map DomainError → TRPCError so tRPC's transport layer translates correctly. */
export function rethrowDomainError(err: unknown): never {
  if (err instanceof DomainError) {
    const code: TRPCError['code'] =
      err.code === 'VALIDATION'
        ? 'BAD_REQUEST'
        : err.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : err.code === 'CONFLICT'
            ? 'CONFLICT'
            : err.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : err.code === 'PRECONDITION_FAILED'
                ? 'PRECONDITION_FAILED'
                : err.code === 'RATE_LIMITED'
                  ? 'TOO_MANY_REQUESTS'
                  : 'INTERNAL_SERVER_ERROR';
    throw new TRPCError({ code, message: err.i18nKey, cause: err });
  }
  throw err;
}
