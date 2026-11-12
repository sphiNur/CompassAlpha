/**
 * Development sign-in for browser QA outside Telegram: the list of
 * personas and the two logins. Each is refused unless the server allows
 * the local developer mock and the request comes straight from this
 * machine or the LAN (modes.ts). They stay mounted on every server: the
 * deploy smoke checks that production refuses them.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { inSystem, type DB } from '@compass/db';
import { publicProcedure } from '../../trpc';
import { signAccess } from '../../../infra/jwt';
import { logger } from '../../../infra/log';
import { executeRows } from '../../../services/sqlRows';
import { buildSessionPayload } from '../../../services/sessionPayload';
import type { RequestContext } from '../../context';
import { enforceRate } from './limits';
import { devLoginUnavailableReason } from './modes';

type LoginIdentity = {
  userId: string;
  memberId: string;
  orgId: string;
};

type DevPersonaRow = {
  user_id: string;
  member_id: string;
  org_id: string;
  org_name: string;
  display_name: string;
  tg_user_id: string | null;
  role_slugs: string | null;
  store_names: string | null;
  is_admin: boolean | string | number | null;
  max_rank: number | string | null;
  permission_count: number | string | null;
};

type DevPersonaIdentityRow = {
  user_id: string;
  member_id: string;
  org_id: string;
};

const DevPersonaLoginInputSchema = z.object({
  memberId: z.string().uuid(),
});

function assertDevLoginAvailable(ctx: RequestContext): void {
  const reason = devLoginUnavailableReason(ctx);
  if (!reason) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: reason,
  });
}

function isDevDatabaseUnavailableError(err: unknown): boolean {
  const e = err as { code?: string; errno?: string; message?: string; cause?: unknown };
  const cause = e?.cause as { code?: string; message?: string } | undefined;
  const code = e?.code ?? e?.errno ?? cause?.code;
  const message = `${e?.message ?? ''} ${cause?.message ?? ''}`;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    message.includes('ECONNREFUSED') ||
    message.includes('Connection terminated') ||
    message.includes('connect ETIMEDOUT')
  );
}

function throwDevDatabaseUnavailable(err: unknown): never {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    'auth.devLogin database unavailable',
  );
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'auth.errors.devDatabaseUnavailable',
  });
}

function rethrowDevLoginDatabaseError(err: unknown): never {
  if (isDevDatabaseUnavailableError(err)) throwDevDatabaseUnavailable(err);
  throw err;
}

async function findDevBypassIdentity(db: DB): Promise<LoginIdentity> {
  const rows = await inSystem(db, 'auth', (tx) =>
    tx.execute<{
      user_id: string;
      member_id: string;
      org_id: string;
    }>(sql`
    SELECT
      m.user_id::text AS user_id,
      m.id::text AS member_id,
      m.org_id::text AS org_id
    FROM auth.members m
    INNER JOIN auth.users u ON u.id = m.user_id
    INNER JOIN auth.organizations o ON o.id = m.org_id
    WHERE m.status = 'active'
      AND u.deleted_at IS NULL
      AND o.deleted_at IS NULL
    ORDER BY
      EXISTS (
        SELECT 1
        FROM auth.member_role_bindings mrb
        INNER JOIN auth.role_permissions rp ON rp.role_id = mrb.role_id
        WHERE mrb.member_id = m.id
          AND rp.permission_key = 'users.manage'
      ) DESC,
      u.display_name_locked DESC,
      m.joined_at ASC
    LIMIT 1
  `),
  );
  const picked = executeRows<(typeof rows)[number]>(rows)[0];
  if (!picked) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'auth.errors.devBypassNoMember',
    });
  }
  return {
    userId: picked.user_id,
    memberId: picked.member_id,
    orgId: picked.org_id,
  };
}

async function findDevPersonaIdentity(db: DB, memberId: string): Promise<LoginIdentity> {
  const rows = await inSystem(db, 'auth', (tx) =>
    tx.execute<DevPersonaIdentityRow>(sql`
    SELECT
      m.user_id::text AS user_id,
      m.id::text AS member_id,
      m.org_id::text AS org_id
    FROM auth.members m
    INNER JOIN auth.users u ON u.id = m.user_id
    INNER JOIN auth.organizations o ON o.id = m.org_id
    WHERE m.id = ${memberId}
      AND m.status = 'active'
      AND u.deleted_at IS NULL
      AND o.deleted_at IS NULL
    LIMIT 1
  `),
  );
  const picked = executeRows<DevPersonaIdentityRow>(rows)[0];
  if (!picked) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'auth.errors.devPersonaMissing',
    });
  }
  return {
    userId: picked.user_id,
    memberId: picked.member_id,
    orgId: picked.org_id,
  };
}

async function issueDevBypassLoginResult(db: DB, userId: string, memberId: string, orgId: string) {
  const session = await buildSessionPayload(db, userId, memberId, orgId);
  const accessToken = await signAccess({ sub: userId, org: session.member.orgId, mid: memberId });
  const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  return {
    tokens: {
      accessToken,
      // Keep this truthy so the normal AuthGate/auth.me synchronization
      // path runs in the browser, but deliberately do not issue a tracked
      // refresh token. If this access token expires, refresh fails, auth
      // clears, and the development-only bypass logs in again.
      //
      // 2026-07-30: the sentinel used to be 'dev-bypass' — 10 characters,
      // against a `RefreshInputSchema` of `z.string().min(20).max(200)`.
      // So auth.refresh answered 400 BAD_REQUEST with a Zod `too_small`
      // dump rather than 401. Same outcome for the client (any non-ok
      // response clears auth), but it reads like a client bug and sent a
      // debugging session chasing a malformed request instead of an
      // expired session. Long enough to reach the handler now, where
      // verifyRefresh rejects it as what it actually is: not a valid
      // refresh token.
      refreshToken: 'dev-bypass-no-refresh-token',
      accessExpiresAt,
      refreshExpiresAt: accessExpiresAt,
    },
    session,
  };
}

export const devLoginProcedures = {
  /**
   * Development-only persona list for browser QA outside Telegram.
   *
   * This endpoint exposes only existing active members in the local
   * development database. It is unavailable outside localhost +
   * development, so production users never see or hit this path.
   */
  devPersonas: publicProcedure.query(async ({ ctx }) => {
    enforceRate('devPersonas', ctx.trustedIp);
    assertDevLoginAvailable(ctx);
    let rows: DevPersonaRow[] | { rows?: DevPersonaRow[] };
    try {
      rows = await inSystem(ctx.db, 'auth', (tx) =>
        tx.execute<DevPersonaRow>(sql`
        SELECT
          u.id::text AS user_id,
          m.id::text AS member_id,
          m.org_id::text AS org_id,
          o.name AS org_name,
          u.display_name AS display_name,
          u.tg_user_id::text AS tg_user_id,
          STRING_AGG(DISTINCT r.slug, ',' ORDER BY r.slug) AS role_slugs,
          STRING_AGG(DISTINCT st.name, ',' ORDER BY st.name) AS store_names,
          COALESCE(BOOL_OR(rp.permission_key = 'users.manage'), false) AS is_admin,
          COALESCE(MAX(r.rank), 0) AS max_rank,
          COUNT(DISTINCT rp.permission_key)::int AS permission_count
        FROM auth.members m
        INNER JOIN auth.users u ON u.id = m.user_id
        INNER JOIN auth.organizations o ON o.id = m.org_id
        LEFT JOIN auth.member_role_bindings mrb ON mrb.member_id = m.id
        LEFT JOIN auth.roles r ON r.id = mrb.role_id
        LEFT JOIN auth.role_permissions rp ON rp.role_id = r.id
        LEFT JOIN auth.member_store_assignments msa ON msa.member_id = m.id
        LEFT JOIN inventory.stores st ON st.id = msa.store_id AND st.is_active = true
        WHERE m.status = 'active'
          AND u.deleted_at IS NULL
          AND o.deleted_at IS NULL
        GROUP BY u.id, m.id, m.org_id, o.name, u.display_name, u.tg_user_id
        ORDER BY
          COALESCE(BOOL_OR(rp.permission_key = 'users.manage'), false) DESC,
          COALESCE(MAX(r.rank), 0) DESC,
          LOWER(u.display_name) ASC
        LIMIT 50
      `),
      );
    } catch (err) {
      rethrowDevLoginDatabaseError(err);
    }
    return executeRows<DevPersonaRow>(rows).map((row) => ({
      memberId: row.member_id,
      userId: row.user_id,
      orgId: row.org_id,
      orgName: row.org_name,
      displayName: row.display_name,
      tgUserId: row.tg_user_id,
      roleSlugs: row.role_slugs ? row.role_slugs.split(',').filter(Boolean) : [],
      storeNames: row.store_names ? row.store_names.split(',').filter(Boolean) : [],
      isAdmin: row.is_admin === true || row.is_admin === 'true' || row.is_admin === 1,
      maxRank: Number(row.max_rank ?? 0),
      permissionCount: Number(row.permission_count ?? 0),
    }));
  }),

  /**
   * Development-only browser bypass for local UI work.
   *
   * This exists so Codex / browser QA can open the Mini App outside
   * Telegram without stopping on the Telegram access screen. It never
   * accepts a user id from the client and never creates or grants
   * access. The server picks an existing active member from the local
   * database, preferring an admin account so all screens are reachable.
   */
  devBypassLogin: publicProcedure.mutation(async ({ ctx }) => {
    enforceRate('devBypassLogin', ctx.trustedIp);
    assertDevLoginAvailable(ctx);
    let identity: LoginIdentity;
    try {
      identity = await findDevBypassIdentity(ctx.db);
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      rethrowDevLoginDatabaseError(err);
    }
    return issueDevBypassLoginResult(ctx.db, identity.userId, identity.memberId, identity.orgId);
  }),

  devPersonaLogin: publicProcedure
    .input(DevPersonaLoginInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceRate('devPersonaLogin', ctx.trustedIp);
      assertDevLoginAvailable(ctx);
      let identity: LoginIdentity;
      try {
        identity = await findDevPersonaIdentity(ctx.db, input.memberId);
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        rethrowDevLoginDatabaseError(err);
      }
      return issueDevBypassLoginResult(ctx.db, identity.userId, identity.memberId, identity.orgId);
    }),
};
