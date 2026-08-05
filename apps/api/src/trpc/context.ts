import type { Context as HonoContext } from 'hono';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext, type OrgTransactionOptions } from '@compass/db';
import { verifyAccess } from '../infra/jwt';
import { logger } from '../infra/log';
import { env } from '../env';
import { ulid } from 'ulid';
import { hasGlobalOrgAdmin } from '../services/orgAdmin';

export interface SessionContext {
  userId: string;
  memberId: string;
  orgId: string;
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
}

export interface RequestContext {
  hono: HonoContext;
  db: ReturnType<typeof getDb>;
  log: typeof logger;
  traceId: string;
  ip: string | null;
  userAgent: string | null;
  /** M1.20 (2026-05-08): client-supplied idempotency key from the
   *  `X-Idempotency-Key` request header. Read by the `idempotent`
   *  tRPC middleware to dedupe replay-safe mutations. Null when the
   *  client didn't send one (legacy clients, queries, optional). */
  idempotencyKey: string | null;
  /** Resolved when request carried a valid Bearer token. */
  session: SessionContext | null;
  /** Run a callback inside a tx with RLS org context bound. */
  withOrg<T>(
    fn: (tx: ReturnType<typeof getDb>) => Promise<T>,
    options?: OrgTransactionOptions,
  ): Promise<T>;
}

export async function createContext(_opts: unknown, c: HonoContext): Promise<RequestContext> {
  const db = getDb(env.DATABASE_URL);
  const traceId = c.req.header('x-trace-id') ?? ulid();
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  // M1.20: read idempotency key. Clip to 128 chars to match the
  // column width in sync.idempotency_keys; ignore empty strings so
  // a client sending `X-Idempotency-Key: ` (no value) doesn't get
  // dedupe behavior.
  const rawIdem = c.req.header('x-idempotency-key');
  const idempotencyKey = rawIdem && rawIdem.trim().length > 0 ? rawIdem.trim().slice(0, 128) : null;
  const auth = c.req.header('authorization');

  let session: SessionContext | null = null;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const claims = await verifyAccess(token);
      session = await loadSession(db, claims.sub, claims.org, claims.mid);
    } catch (err) {
      logger.warn({ err: (err as Error).message, traceId }, 'invalid jwt; treating as anonymous');
    }
  }

  return {
    hono: c,
    db,
    log: logger.child({ traceId }),
    traceId,
    ip,
    userAgent,
    idempotencyKey,
    session,
    async withOrg(fn, options) {
      if (!session) throw new Error('withOrg requires authenticated session');
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

export async function loadSession(
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

  const bindings = await db
    .select({ role: s.roles, binding: s.memberRoleBindings })
    .from(s.memberRoleBindings)
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(
      and(
        eq(s.memberRoleBindings.memberId, member.id),
        or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, new Date())),
      ),
    );

  const roleIds = bindings.map((b) => b.role.id);
  const perms = roleIds.length
    ? await db.query.rolePermissions.findMany({
        where: (rp, { inArray }) => inArray(rp.roleId, roleIds),
      })
    : [];
  const isGlobalOrgAdmin = await hasGlobalOrgAdmin(db, member.id);
  const permissions = new Set(perms.map((p) => p.permissionKey));
  // The flat set is used by many legacy permission gates. Preserve its
  // compatibility for ordinary store-scoped permissions, but never let a
  // store-scoped role manufacture the organization-wide marker.
  if (isGlobalOrgAdmin) permissions.add('org.admin');
  else permissions.delete('org.admin');

  // D.1 (M3.39, 2026-05-20): pull the org's timezone alongside the
  // member/perms lookup so routers can resolve "today" correctly. The
  // organizations row is cached at the db driver level for this
  // request; a single round-trip in addition to the member fetch.
  const org = await db.query.organizations.findFirst({
    where: (o, { eq: eq2 }) => eq2(o.id, orgId),
    columns: { timezone: true },
  });
  const orgTimezone = org?.timezone ?? 'UTC';

  return {
    userId,
    memberId,
    orgId,
    orgTimezone,
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
