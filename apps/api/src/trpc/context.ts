import type { Context as HonoContext } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { verifyAccess } from '../infra/jwt';
import { logger } from '../infra/log';
import { env } from '../env';
import { ulid } from 'ulid';

export interface SessionContext {
  userId: string;
  memberId: string;
  orgId: string;
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
  withOrg<T>(fn: (tx: ReturnType<typeof getDb>) => Promise<T>): Promise<T>;
}

export async function createContext(
  _opts: unknown,
  c: HonoContext,
): Promise<RequestContext> {
  const db = getDb(env.DATABASE_URL);
  const traceId = c.req.header('x-trace-id') ?? ulid();
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  // M1.20: read idempotency key. Clip to 128 chars to match the
  // column width in sync.idempotency_keys; ignore empty strings so
  // a client sending `X-Idempotency-Key: ` (no value) doesn't get
  // dedupe behavior.
  const rawIdem = c.req.header('x-idempotency-key');
  const idempotencyKey =
    rawIdem && rawIdem.trim().length > 0 ? rawIdem.trim().slice(0, 128) : null;
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
    async withOrg(fn) {
      if (!session) throw new Error('withOrg requires authenticated session');
      return withOrgContext(db, session.orgId, fn);
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
    .where(eq(s.memberRoleBindings.memberId, member.id));

  const roleIds = bindings.map((b) => b.role.id);
  const perms = roleIds.length
    ? await db.query.rolePermissions.findMany({
        where: (rp, { inArray }) => inArray(rp.roleId, roleIds),
      })
    : [];

  return {
    userId,
    memberId,
    orgId,
    roleSlugs: new Set(bindings.map((b) => b.role.slug)),
    permissions: new Set(perms.map((p) => p.permissionKey)),
  };
}
