import { initTRPC, TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { DomainError } from '@compass/domain';
import { schema as s, withOrgContext, type PermissionKey } from '@compass/db';
import type { RequestContext } from './context';
import { logger } from '../infra/log';
import { checkRate } from '../services/rateLimit';
import { isUniqueViolation } from '../services/pgErrors';
import { stableJson } from '../services/stableJson';

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

/**
 * Procedure metadata. `idempotent` marks the procedures built from
 * `idempotentMutation`, so a test can list them from the router
 * (TEST3-06).
 */
export interface ProcedureMeta {
  idempotent?: boolean;
}

const trpcBuilder = initTRPC.context<RequestContext>().meta<ProcedureMeta>();

const t = trpcBuilder.create({
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
 * Failed calls in the journal (COREAPI-02, 2026-11-09). A procedure's
 * failure comes back from `opts.next()` as `{ ok: false, error }`: tRPC v11
 * does not throw it, so the try/catch that stood here (M1.9-extra P7)
 * never ran and no refusal was ever logged. The tRPC onError (app.ts)
 * still logs INTERNAL_SERVER_ERROR with its cause; this logs the rest.
 */
const errorLogMiddleware = t.middleware(async (opts) => {
  const result = await opts.next();
  if (!result.ok) logFailedCall(opts.ctx, opts.path, opts.type, result.error);
  return result;
});

/**
 * One line per failed call: what was called, by whom, the key the client
 * was shown and the refusal's own details. Never the input, which can
 * hold photos, coordinates or names, and no name from the details either
 * (attendance's "just punched" names the colleague).
 *   - Another server fault (5xx: the database was down): warn.
 *   - A refused mutation (permission, rule, validation, conflict, rate
 *     limit): info. This answers "I tapped and nothing happened".
 *   - A refused query, or a call without a session (the app then refreshes
 *     its token): debug. Pages poll, and these are routine.
 */
export function logFailedCall(
  ctx: Pick<RequestContext, 'traceId' | 'session'>,
  path: string,
  type: string,
  error: TRPCError,
): void {
  if (error.code === 'INTERNAL_SERVER_ERROR') return;
  const level =
    getHTTPStatusCodeFromError(error) >= 500
      ? 'warn'
      : type === 'mutation' && error.message !== 'auth.errors.required'
        ? 'info'
        : 'debug';
  const cause = error.cause;
  const missing = cause as
    | { missingPermission?: unknown; missingPermissionAny?: unknown }
    | undefined;
  const details =
    cause instanceof ZodError
      ? { key: 'common.errors.validation', fields: Object.keys(cause.flatten().fieldErrors) }
      : {
          key: error.message,
          context: withoutNames(cause instanceof DomainError ? cause.context : causeContext(cause)),
          missingPermission: missing?.missingPermission ?? missing?.missingPermissionAny,
        };
  logger[level](
    {
      path,
      type,
      code: error.code,
      ...details,
      traceId: ctx.traceId,
      userId: ctx.session?.userId,
      orgId: ctx.session?.orgId,
    },
    `trpc ${error.code} ${path}`,
  );
}

/** `context` less the people's names it may carry (`name`, `…Name`). */
function withoutNames(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return Object.fromEntries(Object.entries(context).filter(([k]) => !/(^n|N)ame$/.test(k)));
}

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
 * Only the signed-in chain (`authedProcedure`) has it. `system.log` is a
 * public procedure with its own limit per client address (system.ts).
 *
 * Key shape: `{userId}:{path}` so a user can't starve themselves
 * across paths, and one chatty path can't starve quieter ones.
 */
const mutationRateMiddleware = t.middleware(async (opts) => {
  if (opts.type !== 'mutation') return opts.next();
  const userId = opts.ctx.session?.userId ?? null;
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

/**
 * Mutations that only delete a person's face data stay open in a
 * read-only workspace (review 2026-11-07): withdrawing consent must work
 * whether or not the subscription is paid.
 */
const ERASE_WHEN_READ_ONLY: ReadonlySet<string> = new Set([
  'attendance.faceConsentWithdraw',
  'attendance.faceEnrollReset',
]);

/** Authenticated user required. */
export const authedProcedure = t.procedure
  .use(errorLogMiddleware)
  .use(mutationRateMiddleware)
  .use(async (opts) => {
    if (!opts.ctx.session) {
      // COREAPI-15: the database, not the sign-in, failed. The app retries
      // (a queued write stays queued) instead of refreshing its token.
      if (opts.ctx.sessionUnavailable) {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'common.errors.internal' });
      }
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
      opts.path.startsWith('platform.') ||
      ERASE_WHEN_READ_ONLY.has(opts.path);
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
 *      transient). A SQL NULL `response` is a claim still running;
 *      a handler that answered nothing is cached as JSON `null`
 *      (review COREAPI-31: it read as running, so each retry waited
 *      and was refused as in flight for the next 24 hours).
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

/**
 * The middleware result a cache hit answers with, without running the
 * handler. Returning the raw payload (no `ok` field) made tRPC's caller
 * treat it as a FAILED middleware result (P0 H2). The caller reads only
 * `.ok`/`.data`; `ctx` and (once captured) `marker` match a real result.
 * Exported for idempotency-middleware.test.ts.
 */
export function cacheHitResult(response: unknown, ctx: unknown) {
  return {
    ok: true as const,
    data: response,
    ctx,
    ...(capturedMiddlewareMarker !== undefined ? { marker: capturedMiddlewareMarker } : {}),
  };
}

const idempotencyMiddleware = t.middleware(async (opts) => {
  const key = opts.ctx.idempotencyKey;
  const userId = opts.ctx.session?.userId ?? null;
  const orgId = opts.ctx.session?.orgId ?? null;
  // No key = no dedupe. Mutation runs normally.
  if (!key || !userId || !orgId || opts.type !== 'mutation') {
    return opts.next();
  }
  const db = opts.ctx.db;
  // A procedure without input (attendance.faceConsentWithdraw) gets an
  // empty body over HTTP, which getRawInput cannot parse as JSON; that
  // failed every such call (2026-11-07). No input hashes as null, and a
  // body that really is broken is refused by the input parser anyway.
  const requestHash = idempotencyRequestHash(await opts.getRawInput().catch(() => null));
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
  const readOwn = async () => {
    const [row] = await withOrgContext(db, orgId, (tx) =>
      tx
        .select({
          response: s.idempotencyKeys.response,
          requestHash: s.idempotencyKeys.requestHash,
          // SQL NULL: the claim's request is still running (COREAPI-31).
          running: sql<boolean>`${s.idempotencyKeys.response} IS NULL`,
        })
        .from(s.idempotencyKeys)
        .where(
          and(
            eq(s.idempotencyKeys.key, key),
            eq(s.idempotencyKeys.route, opts.path),
            eq(s.idempotencyKeys.userId, userId),
            gt(s.idempotencyKeys.expiresAt, new Date()),
          ),
        )
        .limit(1),
    );
    return row;
  };
  const cachedResult = (response: unknown) =>
    cacheHitResult(response, opts.ctx) as unknown as Awaited<ReturnType<typeof opts.next>>;

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
      if (!existing.running) {
        // M3.9: debug, not info — cache hits are the good path.
        logger.debug(
          { path: opts.path, userId, key },
          'idempotency cache hit — returning prior response',
        );
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
  // A failure comes back as `{ ok: false }` (tRPC v11 does not throw it).
  const result = await opts.next();
  if (capturedMiddlewareMarker === undefined) capturedMiddlewareMarker = result.marker;
  if (result.ok) {
    const data = result.data;
    try {
      await withOrgContext(db, orgId, (tx) =>
        tx
          .update(s.idempotencyKeys)
          .set({
            // No answer is stored as JSON null: SQL NULL means running.
            response: data === undefined || data === null ? sql`'null'::jsonb` : data,
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
 * The procedures that use it are listed once, in IDEMPOTENT_ROUTES
 * (packages/contracts/src/idempotency.ts); a test fails when the two
 * differ.
 *
 * Anything that ONLY reads, OR that has natural-key dedupe through
 * an event-store unique seq, can stay on plain authedProcedure.
 */
export const idempotentMutation = authedProcedure
  .use(idempotencyMiddleware)
  .meta({ idempotent: true });

/**
 * A signed-in procedure that needs `permissionKey` in the session's
 * permissions: the keys the member holds organisation-wide or in at
 * least one store (services/storeScope.ts, flatEffectivePermissions). It
 * looks at no store in the input; a procedure that acts on one store
 * checks that store's permissions itself.
 */
export function permissionProcedure(permissionKey: PermissionKey) {
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

/**
 * 2026-10-21 audit CA-40 (E-09): turn a unique-index violation (category
 * slug, SKU / store / dish code — all unique per org) into a specific 409
 * key instead of a generic 500. The transaction is aborted either way;
 * this only changes what the caller is told. Review ADM1-11
 * (2026-11-12): moved here from the admin router, for the dishes router
 * too.
 */
export async function withUniqueKey<T>(op: PromiseLike<T>, message: string): Promise<T> {
  try {
    return await op;
  } catch (err) {
    if (isUniqueViolation(err)) throw new TRPCError({ code: 'CONFLICT', message, cause: err });
    throw err;
  }
}
