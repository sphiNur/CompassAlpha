import type { Context as HonoContext } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext, type OrgTransactionOptions } from '@compass/db';
import { verifyAccess, type AccessClaims } from '../infra/jwt';
import { logger } from '../infra/log';
import { env } from '../env';
import { ulid } from 'ulid';
import { flatEffectivePermissions } from '../services/storeScope';
import { bindingIsLive, overrideIsLive } from '../services/liveGrants';
import { readSessionTenant } from '../services/subscription';
import { trustedClientIp } from '../services/clientIp';

export interface SessionContext {
  userId: string;
  memberId: string;
  orgId: string;
  /** Subscription status controls whether business mutations are allowed. */
  writeAccess?: boolean;
  /**
   * IANA timezone for the org — D.1 (M3.39, 2026-05-20). Drives "today's
   * date" calculations in order.todaySession / run.create / submit
   * defaults. Loaded alongside member/permissions so every router can
   * resolve the right day boundary without a per-request roundtrip.
   * Defaults to 'UTC' if the org row is missing (defensive only — the
   * column is NOT NULL with a default, so this branch is unreachable).
   */
  orgTimezone: string;
  permissions: ReadonlySet<string>;
  roleSlugs: ReadonlySet<string>;
  /** Refresh chain this access token was issued with (AUTH-11); absent
   *  on access tokens signed before the claim existed. */
  refreshFamily?: string;
}

export interface RequestContext {
  hono: HonoContext;
  db: ReturnType<typeof getDb>;
  log: typeof logger;
  traceId: string;
  ip: string | null;
  /**
   * Client address the rate limiter may trust (AUTH-6); null when there
   * is none and the caller shares one bucket. `ip` above stays as it was
   * for logging.
   */
  trustedIp?: string | null;
  /**
   * The socket's real peer address (Bun's `server.requestIP`, handed to
   * Hono by main.ts as `c.env.peerIp`); null when unknown (tests, or a
   * runtime that does not report it). Only the dev-login locality check
   * reads it (D21).
   */
  peerIp?: string | null;
  userAgent: string | null;
  /** M1.20 (2026-05-08): client-supplied idempotency key from the
   *  `X-Idempotency-Key` request header. Read by the `idempotent`
   *  tRPC middleware to dedupe replay-safe mutations. Null when the
   *  client didn't send one (legacy clients, queries, optional). */
  idempotencyKey: string | null;
  /** Resolved when request carried a valid Bearer token. */
  session: SessionContext | null;
  /**
   * COREAPI-15 (2026-11-09): the token was valid but the session could not
   * be read (the database failed). Signed-in procedures then answer
   * SERVICE_UNAVAILABLE instead of UNAUTHORIZED, which sent the app off to
   * refresh its token over a database problem.
   */
  sessionUnavailable?: boolean;
  /** Run a callback inside a tx with RLS org context bound. */
  withOrg<T>(
    fn: (tx: ReturnType<typeof getDb>) => Promise<T>,
    options?: OrgTransactionOptions,
  ): Promise<T>;
}

/**
 * The session a Bearer token stands for.
 *
 * COREAPI-15 (2026-11-09): a bad token makes the request anonymous; a
 * good token whose session cannot be read (the database failed) is
 * `unavailable`, not anonymous. The two used to share one catch, so a
 * database hiccup answered signed-in users UNAUTHORIZED, the app went to
 * refresh its token (failing the same way), and the log blamed the JWT.
 * The socket upgrade already answers that case 503 (realtime/socket.ts).
 */
export async function sessionFromToken(
  token: string,
  deps: {
    verifyAccess: (token: string) => Promise<AccessClaims>;
    loadSession: (
      userId: string,
      orgId: string,
      memberId: string,
    ) => Promise<SessionContext | null>;
    log: Pick<typeof logger, 'warn' | 'error'>;
  },
): Promise<{ session: SessionContext | null; unavailable: boolean }> {
  let claims: AccessClaims;
  try {
    claims = await deps.verifyAccess(token);
  } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'invalid jwt; treating as anonymous');
    return { session: null, unavailable: false };
  }
  try {
    const session = await deps.loadSession(claims.sub, claims.org, claims.mid);
    if (session && typeof claims.fam === 'string') session.refreshFamily = claims.fam;
    return { session, unavailable: false };
  } catch (err) {
    deps.log.error({ err }, 'session lookup failed');
    return { session: null, unavailable: true };
  }
}

export async function createContext(_opts: unknown, c: HonoContext): Promise<RequestContext> {
  const db = getDb(env.DATABASE_URL);
  const traceId = c.req.header('x-trace-id') ?? ulid();
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  const trustedIp = trustedClientIp((name) => c.req.header(name), env.CLIENT_IP_PROXY_KEY);
  const peerIp = (c.env as { peerIp?: string | null } | undefined)?.peerIp ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  // M1.20: read idempotency key. Clip to 128 chars to match the
  // column width in sync.idempotency_keys; ignore empty strings so
  // a client sending `X-Idempotency-Key: ` (no value) doesn't get
  // dedupe behavior.
  const rawIdem = c.req.header('x-idempotency-key');
  const idempotencyKey = rawIdem && rawIdem.trim().length > 0 ? rawIdem.trim().slice(0, 128) : null;
  const auth = c.req.header('authorization');

  const { session, unavailable: sessionUnavailable } = auth?.startsWith('Bearer ')
    ? await sessionFromToken(auth.slice(7), {
        verifyAccess,
        loadSession: (userId, orgId, memberId) => loadSession(db, userId, orgId, memberId),
        log: logger.child({ traceId }),
      })
    : { session: null, unavailable: false };

  return {
    hono: c,
    db,
    log: logger.child({ traceId }),
    traceId,
    ip,
    trustedIp,
    peerIp,
    userAgent,
    idempotencyKey,
    session,
    sessionUnavailable,
    async withOrg(fn, options) {
      if (!session) throw new Error('withOrg requires authenticated session');
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

/**
 * Who is making this request and what they may do. The access token names
 * the organisation, so the lookup runs inside it: a token for one tenant
 * cannot be made to load a member of another.
 */
export function loadSession(
  db: ReturnType<typeof getDb>,
  userId: string,
  orgId: string,
  memberId: string,
): Promise<SessionContext | null> {
  return withOrgContext(db, orgId, (tx) => readSession(tx, userId, orgId, memberId));
}

async function readSession(
  db: ReturnType<typeof getDb>,
  userId: string,
  orgId: string,
  memberId: string,
): Promise<SessionContext | null> {
  const member = await db.query.members.findFirst({
    where: (m, { eq: eq2, and }) =>
      and(eq2(m.id, memberId), eq2(m.userId, userId), eq2(m.orgId, orgId)),
  });
  if (!member || member.status !== 'active') return null;
  // Write access and the org's time zone (D.1, M3.39), so routers resolve
  // "today" correctly: one query (review COREAPI-23).
  const tenant = await readSessionTenant(db, orgId);

  const bindings = await db
    .select({ role: s.roles, binding: s.memberRoleBindings })
    .from(s.memberRoleBindings)
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(and(eq(s.memberRoleBindings.memberId, member.id), bindingIsLive()));

  const roleIds = bindings.map((b) => b.role.id);
  const perms = roleIds.length
    ? await db.query.rolePermissions.findMany({
        where: (rp, { inArray }) => inArray(rp.roleId, roleIds),
      })
    : [];
  const overrides = await db
    .select({
      key: s.memberPermissionOverrides.permissionKey,
      effect: s.memberPermissionOverrides.effect,
      scopeType: s.memberPermissionOverrides.scopeType,
      scopeId: s.memberPermissionOverrides.scopeId,
    })
    .from(s.memberPermissionOverrides)
    .where(and(eq(s.memberPermissionOverrides.memberId, member.id), overrideIsLive()));
  const keysByRole = new Map<string, string[]>();
  for (const p of perms)
    keysByRole.set(p.roleId, [...(keysByRole.get(p.roleId) ?? []), p.permissionKey]);
  // Keys effective in at least one scope, overrides applied (ADM-1). An
  // organisation-wide key (org.admin) counts from global rows only, so a
  // store-scoped role or override never makes anyone an org admin. The
  // separate org.admin lookup that stood here gave the same answer with
  // two more queries (review COREAPI-23).
  const permissions = flatEffectivePermissions(
    bindings.flatMap((b) =>
      (keysByRole.get(b.role.id) ?? []).map((key) => ({
        key,
        scopeType: b.binding.scopeType,
        scopeId: b.binding.scopeId,
      })),
    ),
    overrides,
  );

  return {
    userId,
    memberId,
    orgId,
    writeAccess: tenant.writeAccess,
    orgTimezone: tenant.timezone,
    // A few destructive maintenance endpoints use this legacy slug gate.
    // Treat `super_admin` as global-only for the same reason as org.admin.
    roleSlugs: new Set(
      bindings
        .filter((b) => b.role.slug !== 'super_admin' || b.binding.scopeType === 'global')
        .map((b) => b.role.slug),
    ),
    permissions,
  };
}
