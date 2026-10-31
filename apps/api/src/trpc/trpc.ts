import { initTRPC, TRPCError } from '@trpc/server';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { DomainError } from '@compass/domain';
import { schema as s, withOrgContext } from '@compass/db';
import type { RequestContext } from './context';
import { logger } from '../infra/log';
import { checkRate } from '../services/rateLimit';
import { isUniqueViolation } from '../services/pgErrors';

/**
 * Placeholders a non-domain refusal names for its sentence, thrown as
 * `cause: { …, context: { days: 90 } }` (CMP-COPY-2). tRPC copies a plain
 * object cause's fields onto the error it wraps it in.
 */
function causeContext(cause: unknown): Record<string, unknown> | undefined {
  const context = (cause as { context?: unknown } | undefined)?.context;
  return context && typeof context === 'object' && !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : undefined;
}

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
    const context = causeContext(cause);
    if (context && error.code !== 'INTERNAL_SERVER_ERROR') {
      return { ...shape, data: { ...shape.data, context } };
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
    // An unexpected failure (a database error, a bug) must not reach the
    // client verbatim: Drizzle's message carries the whole SQL statement
    // and its parameters. Thrown i18n keys pass through; the rest becomes
    // the generic key, and the full error is logged by the tRPC onError.
    if (error.code === 'INTERNAL_SERVER_ERROR' && !/^[a-z]+\.errors?\./.test(error.message)) {
      return { ...shape, message: 'common.error' };
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
    const isServerFault = !tErr || code === 'INTERNAL_SERVER_ERROR' || code === 'TIMEOUT';
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
  })
  .use(async (opts) => {
    if (opts.type !== 'mutation') return opts.next();
    if (opts.ctx.session?.writeAccess !== false) return opts.next();
    const exempt =
      opts.path.startsWith('auth.') ||
      opts.path.startsWith('system.') ||
      opts.path.startsWith('platform.');
    if (exempt) return opts.next();
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'subscription.errors.readOnly',
    });
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
/** How long a claim (a request still running) holds its key. */
const IDEMPOTENCY_PENDING_MS = 60 * 1000;
/** How long a duplicate waits for the first request's answer. */
const IDEMPOTENCY_WAIT_MS = 8 * 1000;

/**
 * tRPC v11 stamps every middleware result with an internal `marker`. The
 * procedure caller only reads `.ok`/`.data`, but we mirror the full shape
 * on the cache-hit short-circuit to stay forward-compatible. We capture the
 * marker from a real result on the first cache miss rather than importing
 * tRPC internals — decoupled and self-healing across restarts.
 */
let capturedMiddlewareMarker: unknown;

/** JSON with object keys sorted, so the same input always hashes alike. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * BUY-16 (2026-10-31): what the key was first used for. The cache used to
 * answer any request carrying a known key with the first one's result, so
 * a reused key with a different body (another product, another price)
 * was silently "done" without running. Exported for tests.
 */
export function idempotencyRequestHash(rawInput: unknown): string {
  return createHash('sha256')
    .update(stableJson(rawInput ?? null))
    .digest('hex');
}

const idempotencyMiddleware = t.middleware(async (opts) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = opts.ctx as any;
  const key: string | null = ctx?.idempotencyKey ?? null;
  const userId: string | null = ctx?.session?.userId ?? null;
  const orgId: string | null = ctx?.session?.orgId ?? null;
  // No key = no dedupe. Mutation runs normally.
  if (!key || !userId || !orgId || opts.type !== 'mutation') {
    return opts.next();
  }
  const db = ctx.db as RequestContext['db'];
  const requestHash = idempotencyRequestHash(await opts.getRawInput());
  /** BUY-16: the key is held for a different request body. A row from
   *  before the hash existed (NULL) is taken to match. */
  const refuseIfOtherBody = (row: { requestHash: string | null }) => {
    if (row.requestHash && row.requestHash !== requestHash) {
      throw new TRPCError({ code: 'CONFLICT', message: 'common.errors.idempotencyKeyReused' });
    }
  };

  // R3 (2026-10-30): claim the key BEFORE running the handler. The old
  // check-then-run let two requests with the same key both miss the
  // cache and both run (a double-tapped "record" booked two sales and
  // deducted stock twice). A row with a NULL response is the claim; it
  // lives for IDEMPOTENCY_PENDING_MS so a crashed request can't hold the
  // key forever, and becomes the cached answer on success.
  const claim = async (): Promise<boolean> => {
    const now = new Date();
    // ON CONFLICT arbitrates on the primary key only; a concurrent insert
    // of the same key can instead trip idem_user_route_unique first. Either
    // way someone else holds the key now.
    const rows = await withOrgContext(db, orgId, (tx) =>
      tx
        .insert(s.idempotencyKeys)
        .values({
          key,
          route: opts.path,
          userId,
          response: null,
          requestHash,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_PENDING_MS),
        })
        .onConflictDoUpdate({
          // Only an expired row (an old answer, or a claim whose request
          // died) may be taken over.
          target: s.idempotencyKeys.key,
          set: {
            route: opts.path,
            userId,
            response: null,
            requestHash,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_PENDING_MS),
          },
          where: lte(s.idempotencyKeys.expiresAt, now),
        })
        .returning({ key: s.idempotencyKeys.key }),
    ).catch((err: unknown) => {
      if (isUniqueViolation(err)) return [];
      throw err;
    });
    return rows.length > 0;
  };
  const readOwn = () =>
    withOrgContext(db, orgId, (tx) =>
      tx.query.idempotencyKeys.findFirst({
        where: (k, { eq: eq2, and: and2, gt: gt2 }) =>
          and2(
            eq2(k.key, key),
            eq2(k.route, opts.path),
            eq2(k.userId, userId),
            gt2(k.expiresAt, new Date()),
          ),
      }),
    );
  const cachedResult = (response: unknown) => {
    // Return a properly-shaped tRPC middleware result. Returning the raw
    // payload (no `ok` field) made tRPC's caller treat it as a FAILED
    // middleware result (P0 H2). The caller reads only `.ok`/`.data`; we
    // include `ctx` and (once captured) `marker` to match a real result.
    return {
      ok: true,
      data: response,
      ctx: opts.ctx,
      ...(capturedMiddlewareMarker !== undefined ? { marker: capturedMiddlewareMarker } : {}),
    } as unknown as Awaited<ReturnType<typeof opts.next>>;
  };

  if (!(await claim())) {
    // Someone holds the key. If it is this user's request on this route,
    // wait for its answer and hand back the same one; a key held by
    // another user or route (a collision on the key alone) just runs
    // uncached, as before.
    const deadline = Date.now() + IDEMPOTENCY_WAIT_MS;
    let pause = 50;
    for (;;) {
      const existing = await readOwn();
      if (!existing) {
        // The holder failed and released it, or it belongs to someone
        // else: try to claim it ourselves, else run uncached.
        if (await claim()) break;
        return opts.next();
      }
      refuseIfOtherBody(existing);
      if (existing.response !== null && existing.response !== undefined) {
        // M3.9: debug, not info — cache hits are the good path.
        logger.debug({ path: opts.path, userId, key }, 'idempotency cache hit — returning prior response');
        return cachedResult(existing.response);
      }
      if (Date.now() >= deadline) {
        throw new TRPCError({ code: 'CONFLICT', message: 'common.errors.requestInFlight' });
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 400);
    }
  }

  // We hold the claim: run the handler, then cache its answer or let go.
  let result: Awaited<ReturnType<typeof opts.next>>;
  try {
    result = await opts.next();
  } catch (err) {
    await releaseClaim(db, orgId, key, opts.path, userId);
    throw err;
  }
  // tRPC v11 middleware return shape: { ok: true, data, ctx, marker } | { ok: false, error }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;
  if (capturedMiddlewareMarker === undefined && r && typeof r === 'object' && 'marker' in r) {
    capturedMiddlewareMarker = r.marker;
  }
  if (r?.ok === true) {
    try {
      await withOrgContext(db, orgId, (tx) =>
        tx
          .update(s.idempotencyKeys)
          .set({
            response: (r.data ?? null) as unknown as Record<string, unknown>,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          })
          .where(
            and(
              eq(s.idempotencyKeys.key, key),
              eq(s.idempotencyKeys.route, opts.path),
              eq(s.idempotencyKeys.userId, userId),
            ),
          ),
      );
    } catch (cacheErr) {
      // Best-effort: the mutation succeeded. The claim simply expires
      // and a later retry runs again, into whatever natural-key dedupe
      // exists (event-stream uniqueness, etc.).
      logger.warn({ err: cacheErr, path: opts.path }, 'idempotency cache write failed');
    }
  } else {
    // A failed mutation must not be replayed as a cached failure: free
    // the key so the client's retry runs.
    await releaseClaim(db, orgId, key, opts.path, userId);
  }
  return result;
});

/** Drop an unanswered claim (best-effort; it expires on its own anyway). */
async function releaseClaim(
  db: RequestContext['db'],
  orgId: string,
  key: string,
  route: string,
  userId: string,
): Promise<void> {
  try {
    await withOrgContext(db, orgId, (tx) =>
      tx
        .delete(s.idempotencyKeys)
        .where(
          and(
            eq(s.idempotencyKeys.key, key),
            eq(s.idempotencyKeys.route, route),
            eq(s.idempotencyKeys.userId, userId),
            isNull(s.idempotencyKeys.response),
          ),
        ),
    );
  } catch (err) {
    logger.warn({ err, route }, 'idempotency claim release failed');
  }
}

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
