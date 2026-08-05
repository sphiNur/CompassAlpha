import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import {
  NonTelegramLoginInputSchema,
  TelegramLoginInputSchema,
  RefreshInputSchema,
  CompleteOnboardingInputSchema,
  type SessionSchema as SessionShape,
} from '@compass/contracts';
import { authedProcedure, publicProcedure, router } from '../trpc';
import { verifyInitData, type TelegramUser } from '../../services/telegramAuth';
import { checkRate } from '../../services/rateLimit';
import { signAccess, verifyRefresh } from '../../infra/jwt';
import {
  issueRefresh,
  consumeRefresh,
  revokeAllForUser,
  RefreshReplayError,
  RefreshNotFoundError,
} from '../../services/refreshTokens';
import { logger } from '../../infra/log';
import { env } from '../../env';
import type { RequestContext } from '../context';

/**
 * Brute-force defence on the two public auth endpoints (added 2026-05-05).
 *
 * `telegramLogin` is the highest-value target: an attacker hammering
 * arbitrary `initData` blobs probes for HMAC weaknesses or ages out
 * Telegram's `auth_date` window. `refresh` is similar — feeding random
 * refresh tokens until something verifies.
 *
 * 5 attempts per IP per minute is generous for a real Telegram WebApp
 * client (which only re-logs in on app restart) but tight enough that
 * a credential-stuffing bot dies in ~12 minutes per IP. Telegram's
 * own bot constraints already limit per-user open rate, so this is
 * defence-in-depth rather than the primary line.
 *
 * Behind Cloudflare we trust `cf-connecting-ip`; fall back to
 * `x-forwarded-for` or null. A null IP means we couldn't identify
 * the caller, so we don't enforce — the alternative is locking out
 * everyone behind a misconfigured proxy.
 */
const AUTH_LIMIT = { window: 60_000, max: 5 } as const;
function enforceRate(scope: string, ip: string | null): void {
  if (!ip) return;
  if (!checkRate(scope, ip, AUTH_LIMIT)) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'auth.errors.rateLimited',
    });
  }
}

type Session = z.infer<typeof SessionShape>;

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

function resultRows<T>(rows: T[] | { rows?: T[] }): T[] {
  return Array.isArray(rows) ? rows : (rows.rows ?? []);
}

function releaseChannel(): 'development' | 'staging' | 'production' {
  return env.COMPASS_RELEASE_CHANNEL ?? (env.NODE_ENV === 'production' ? 'production' : 'development');
}

function parseNonTelegramUsers(): Map<string, string> {
  const raw = env.NON_TELEGRAM_LOGIN_USERS;
  const users = new Map<string, string>();
  if (!raw) return users;

  for (const entry of raw.split(/[,\n;]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 1) continue;

    const tgUserId = trimmed.slice(0, separator).trim();
    const accessCode = trimmed.slice(separator + 1).trim();
    if (!/^\d{4,20}$/.test(tgUserId)) continue;
    if (accessCode.length < 16) continue;
    users.set(tgUserId, accessCode);
  }
  return users;
}

function isNonTelegramLoginAvailable(): boolean {
  if (env.NON_TELEGRAM_LOGIN_ENABLED !== 'true') return false;
  if (releaseChannel() === 'production') return false;
  return parseNonTelegramUsers().size > 0;
}

const DEV_MOCK_INIT_DATA = '1';
const DEV_MOCK_TG_USER: TelegramUser = {
  id: 9_000_000_001,
  first_name: 'Local Developer',
  username: 'compass_local_dev',
  language_code: 'en',
};

/**
 * Browser automation needs a real authenticated session so it can exercise
 * the same tRPC, permission, and realtime paths as Telegram. This route is
 * intentionally narrower than the diagnostic browser login above:
 *
 * - only the literal local mock initData value is accepted;
 * - the server must opt in with DEV_MOCK_LOGIN_ENABLED=true;
 * - both NODE_ENV and release channel must be development;
 * - production release builds cannot carry VITE_DEV_MOCK_INIT_DATA.
 *
 * The identity is created and elevated only in the local seeded database.
 * It is never available to staging or production data.
 */
function isDevMockLoginAvailable(): boolean {
  return (
    env.DEV_MOCK_LOGIN_ENABLED === 'true' &&
    env.NODE_ENV === 'development' &&
    releaseChannel() === 'development'
  );
}

function isLocalhostValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    );
  } catch {
    return (
      trimmed === 'localhost' ||
      trimmed.startsWith('localhost:') ||
      trimmed === '127.0.0.1' ||
      trimmed.startsWith('127.0.0.1:') ||
      trimmed === '::1' ||
      trimmed.startsWith('[::1]:')
    );
  }
}

function isLocalDevRequest(ctx: RequestContext): boolean {
  const host = ctx.hono.req.header('host');
  const origin = ctx.hono.req.header('origin');
  const forwardedHost = ctx.hono.req.header('x-forwarded-host');
  return (
    isLocalhostValue(host) ||
    isLocalhostValue(origin) ||
    isLocalhostValue(forwardedHost) ||
    ctx.ip === '127.0.0.1' ||
    ctx.ip === '::1'
  );
}

function devLoginUnavailableReason(ctx: RequestContext): string | null {
  if (!isDevMockLoginAvailable()) return 'auth.errors.devBypassDisabled';
  if (!isLocalDevRequest(ctx)) return 'auth.errors.devLocalhostOnly';
  return null;
}

function assertDevLoginAvailable(ctx: RequestContext): void {
  const reason = devLoginUnavailableReason(ctx);
  if (!reason) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: reason,
  });
}

function nonTelegramUnavailableReason(): string | null {
  if (env.NON_TELEGRAM_LOGIN_ENABLED !== 'true') {
    return 'auth.errors.nonTelegramLoginDisabled';
  }
  if (releaseChannel() === 'production') {
    return 'auth.errors.nonTelegramProductionDisabled';
  }
  if (parseNonTelegramUsers().size === 0) {
    return 'auth.errors.nonTelegramAllowlistEmpty';
  }
  return null;
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
  const rows = await db.execute<{
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
  `);
  const list = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: typeof rows }).rows ?? []);
  const picked = list[0];
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
  const rows = await db.execute<DevPersonaIdentityRow>(sql`
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
  `);
  const picked = resultRows(rows)[0];
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

async function ensureDevMockAdminAccess(db: DB, memberId: string, orgId: string): Promise<void> {
  const role = await db.query.roles.findFirst({
    where: (r, { and: and2, eq: eq2 }) =>
      and2(eq2(r.orgId, orgId), eq2(r.slug, 'super_admin')),
  });
  if (!role) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'auth.errors.devMockSeedRequired',
    });
  }
  const binding = await db.query.memberRoleBindings.findFirst({
    where: (b, { and: and2, eq: eq2, isNull: isNull2 }) =>
      and2(
        eq2(b.memberId, memberId),
        eq2(b.roleId, role.id),
        eq2(b.scopeType, 'global'),
        isNull2(b.scopeId),
      ),
  });
  if (!binding) {
    await db.insert(s.memberRoleBindings).values({
      memberId,
      roleId: role.id,
      scopeType: 'global',
    });
  }
}

function digestSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function secretsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digestSecret(provided), digestSecret(expected));
}

function isAllowedNonTelegramUser(tgUserId: string, accessCode: string): boolean {
  if (!isNonTelegramLoginAvailable()) return false;
  const expected = parseNonTelegramUsers().get(tgUserId);
  if (!expected) return false;
  return secretsMatch(accessCode.trim(), expected);
}

async function issueLoginResult(
  db: DB,
  userId: string,
  memberId: string,
  orgId: string,
  ip: string | null,
  userAgent: string | null,
) {
  const session = await buildSessionPayload(db, userId, memberId, orgId);
  const accessToken = await signAccess({ sub: userId, org: session.member.orgId, mid: memberId });
  const issued = await issueRefresh(db, {
    userId,
    ip,
    userAgent,
  });

  return {
    tokens: {
      accessToken,
      refreshToken: issued.token,
      accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      refreshExpiresAt: issued.expiresAt.toISOString(),
    },
    session,
  };
}

async function issueDevBypassLoginResult(
  db: DB,
  userId: string,
  memberId: string,
  orgId: string,
) {
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

export const authRouter = router({
  loginModes: publicProcedure.query(({ ctx }) => {
    const devReason = devLoginUnavailableReason(ctx);
    const nonTelegramReason = nonTelegramUnavailableReason();
    return {
      environment: {
        nodeEnv: env.NODE_ENV,
        releaseChannel: releaseChannel(),
        localRequest: isLocalDevRequest(ctx),
      },
      telegram: {
        available: true,
        hasBotToken: Boolean(env.TELEGRAM_BOT_TOKEN),
        requiresInitData: true,
      },
      devPersona: {
        available: devReason === null,
        enabled: env.DEV_MOCK_LOGIN_ENABLED === 'true',
        reason: devReason,
      },
      nonTelegram: {
        available: nonTelegramReason === null,
        enabled: env.NON_TELEGRAM_LOGIN_ENABLED === 'true',
        reason: nonTelegramReason,
      },
    };
  }),

  nonTelegramStatus: publicProcedure.query(() => ({
    enabled: isNonTelegramLoginAvailable(),
  })),

  /**
   * Development-only persona list for browser QA outside Telegram.
   *
   * This endpoint exposes only existing active members in the local
   * development database. It is unavailable outside localhost +
   * development, so production users never see or hit this path.
   */
  devPersonas: publicProcedure.query(async ({ ctx }) => {
    enforceRate('devPersonas', ctx.ip);
    assertDevLoginAvailable(ctx);
    let rows: DevPersonaRow[] | { rows?: DevPersonaRow[] };
    try {
      rows = await ctx.db.execute<DevPersonaRow>(sql`
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
      `);
    } catch (err) {
      rethrowDevLoginDatabaseError(err);
    }
    return resultRows(rows).map((row) => ({
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
    enforceRate('devBypassLogin', ctx.ip);
    assertDevLoginAvailable(ctx);
    let identity: LoginIdentity;
    try {
      identity = await findDevBypassIdentity(ctx.db);
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      rethrowDevLoginDatabaseError(err);
    }
    return issueDevBypassLoginResult(
      ctx.db,
      identity.userId,
      identity.memberId,
      identity.orgId,
    );
  }),

  devPersonaLogin: publicProcedure
    .input(DevPersonaLoginInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceRate('devPersonaLogin', ctx.ip);
      assertDevLoginAvailable(ctx);
      let identity: LoginIdentity;
      try {
        identity = await findDevPersonaIdentity(ctx.db, input.memberId);
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        rethrowDevLoginDatabaseError(err);
      }
      return issueDevBypassLoginResult(
        ctx.db,
        identity.userId,
        identity.memberId,
        identity.orgId,
      );
    }),

  /**
   * Browser-only login for remote development/staging UI checks.
   *
   * This deliberately does NOT create users. The requested Telegram ID
   * must already exist in auth.users and be explicitly listed in
   * NON_TELEGRAM_LOGIN_USERS with its own access code.
   */
  nonTelegramLogin: publicProcedure
    .input(NonTelegramLoginInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceRate('nonTelegramLogin', ctx.ip);
      if (!isNonTelegramLoginAvailable()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.nonTelegramLoginDisabled',
        });
      }
      if (!isAllowedNonTelegramUser(input.tgUserId, input.accessCode)) {
        logger.warn(
          { tgUserId: input.tgUserId, ip: ctx.ip },
          'auth.nonTelegramLogin rejected',
        );
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'auth.errors.invalidNonTelegramLogin',
        });
      }

      const user = await ctx.db.query.users.findFirst({
        where: (u, { eq: eq2 }) => eq2(u.tgUserId, BigInt(input.tgUserId)),
      });
      if (!user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'auth.errors.invalidNonTelegramLogin',
        });
      }

      const member = await ctx.db.query.members.findFirst({
        where: (m, { eq: eq2, and: and2 }) =>
          and2(eq2(m.userId, user.id), eq2(m.status, 'active')),
      });
      if (!member) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.noMembership' });
      }

      await ctx.db
        .update(s.users)
        .set({
          locale: input.locale ?? user.locale ?? 'en',
          lastSeenAt: new Date(),
        })
        .where(eq(s.users.id, user.id));

      return issueLoginResult(ctx.db, user.id, member.id, member.orgId, ctx.ip, ctx.userAgent);
    }),

  /** Login via Telegram Mini App initData. */
  telegramLogin: publicProcedure
    .input(TelegramLoginInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceRate('login', ctx.ip);
      const isDevMock = input.initData === DEV_MOCK_INIT_DATA && isDevMockLoginAvailable();
      let tg: TelegramUser;
      if (isDevMock) {
        tg = DEV_MOCK_TG_USER;
      } else {
        if (!env.TELEGRAM_BOT_TOKEN) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'auth.errors.botTokenMissing' });
        }
        const result = verifyInitData(input.initData, env.TELEGRAM_BOT_TOKEN);
        if (!result.ok || !result.user) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidInitData' });
        }
        tg = result.user;
      }

      // Upsert user.
      let user = await ctx.db.query.users.findFirst({
        where: (u, { eq: eq2 }) => eq2(u.tgUserId, BigInt(tg.id)),
      });
      if (!user) {
        const [created] = await ctx.db
          .insert(s.users)
          .values({
            tgUserId: BigInt(tg.id),
            tgUsername: tg.username ?? null,
            displayName: [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || `user-${tg.id}`,
            avatarUrl: tg.photo_url ?? null,
            locale: input.locale ?? tg.language_code ?? 'en',
            // A local mock is not a person who needs onboarding. Marking it
            // locked avoids creating an otherwise invisible first-run form
            // in browser automation.
            displayNameLocked: isDevMock,
          })
          .returning();
        user = created;
      } else {
        await ctx.db
          .update(s.users)
          .set({
            tgUsername: tg.username ?? user.tgUsername,
            avatarUrl: tg.photo_url ?? user.avatarUrl,
            locale: input.locale ?? user.locale ?? tg.language_code ?? 'en',
            lastSeenAt: new Date(),
          })
          .where(eq(s.users.id, user.id));
      }
      if (!user) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });

      // Find first member in any org. (M0: single-org default; M2: org picker.)
      const member = await ctx.db.query.members.findFirst({
        where: (m, { eq: eq2 }) => eq2(m.userId, user!.id),
      });
      if (!member) {
        // Create membership in 'default' org if it exists.
        const defaultOrg = await ctx.db.query.organizations.findFirst({
          where: (o, { eq: eq2 }) => eq2(o.slug, 'default'),
        });
        if (!defaultOrg) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.noOrg' });
        }
        const [created] = await ctx.db
          .insert(s.members)
          .values({ orgId: defaultOrg.id, userId: user.id })
          .returning();
        if (!created) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      }
      const ensuredMember = member ?? (await ctx.db.query.members.findFirst({ where: (m, { eq: eq2 }) => eq2(m.userId, user!.id) }))!;
      if (isDevMock) {
        await ensureDevMockAdminAccess(ctx.db, ensuredMember.id, ensuredMember.orgId);
      }

      // M1.9 (2026-05-07): refresh tokens are tracked in auth.refresh_tokens
      // with rotation lineage + replay detection.
      return issueLoginResult(
        ctx.db,
        user.id,
        ensuredMember.id,
        ensuredMember.orgId,
        ctx.ip,
        ctx.userAgent,
      );
    }),

  /** Get current session — used by AuthGate. */
  me: authedProcedure.query(async ({ ctx }) => {
    return buildSessionPayload(ctx.db, ctx.session.userId, ctx.session.memberId, ctx.session.orgId);
  }),

  /**
   * One-shot onboarding: user confirms (or rewrites) their displayName,
   * we lock it. After this, only an admin can rename the user via
   * `admin.memberSetDisplayName`. Idempotent — calling twice with the
   * same name is a no-op.
   *
   * Why locked: it prevents staff from impersonating coworkers by
   * suddenly renaming themselves to a manager's name. Names appear in
   * the approval queue, run cockpit, audit log — they need to be stable
   * enough that "@张三" means the same person across contexts.
   */
  completeOnboarding: authedProcedure
    .input(CompleteOnboardingInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.query.users.findFirst({
        where: (u, { eq: eq2 }) => eq2(u.id, ctx.session.userId),
      });
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'auth.errors.userMissing' });
      }
      // Allow re-running for the same name (no-op) so a flaky network
      // retry doesn't surface as an error.
      if (user.displayNameLocked && user.displayName === input.displayName) {
        return buildSessionPayload(
          ctx.db,
          ctx.session.userId,
          ctx.session.memberId,
          ctx.session.orgId,
        );
      }
      // Hard rule: once locked, a user cannot rename themselves.
      if (user.displayNameLocked) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.nameLocked',
        });
      }
      await ctx.db
        .update(s.users)
        .set({
          displayName: input.displayName,
          displayNameLocked: true,
          updatedAt: new Date(),
        })
        .where(eq(s.users.id, ctx.session.userId));
      return buildSessionPayload(
        ctx.db,
        ctx.session.userId,
        ctx.session.memberId,
        ctx.session.orgId,
      );
    }),

  /**
   * User-controlled language override (added 2026-05-05).
   *
   * Telegram exposes `initDataUnsafe.user.language_code` which gives a
   * decent first guess (matches the user's Telegram UI language), but
   * staff often work in mixed-language teams — a Russian-speaking
   * cashier in an Uzbek restaurant may have Telegram set to ru while
   * preferring uz/zh in this app, or vice versa. This mutation lets
   * them pin their preference; the FE reads it back via `auth.me`
   * and `useI18n` resolves it before falling back to Telegram locale.
   *
   * Persists to `auth.users.locale`. The 4 valid codes match the
   * 4-language SKU contract — anything else is rejected.
   */
  setLocale: authedProcedure
    .input(z.object({ locale: z.enum(['en', 'zh', 'ru', 'uz']) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(s.users)
        .set({ locale: input.locale, updatedAt: new Date() })
        .where(eq(s.users.id, ctx.session.userId));
      return buildSessionPayload(
        ctx.db,
        ctx.session.userId,
        ctx.session.memberId,
        ctx.session.orgId,
      );
    }),

  /**
   * M3.45 (2026-05-22): set the user's secondary display language. When
   * set, product names in the UI render as "Primary (Secondary)" and
   * per-vendor copy templates use the secondary locale exclusively (so
   * a Chinese-speaking purchaser can paste a Uzbek list straight into
   * the vendor's chat). Passing `null` clears it (single-language UI,
   * the default).
   *
   * Same enum as setLocale — anything outside the 4-locale contract
   * gets rejected at the input boundary.
   */
  setSecondaryLocale: authedProcedure
    .input(
      z.object({
        secondaryLocale: z.enum(['en', 'zh', 'ru', 'uz']).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(s.users)
        .set({ secondaryLocale: input.secondaryLocale, updatedAt: new Date() })
        .where(eq(s.users.id, ctx.session.userId));
      return buildSessionPayload(
        ctx.db,
        ctx.session.userId,
        ctx.session.memberId,
        ctx.session.orgId,
      );
    }),

  /**
   * Sign out from EVERY device. M1.9 (2026-05-07): finally does
   * something — revokes all of the user's tracked refresh tokens.
   * Access tokens themselves are stateless (15-min TTL) so they can
   * still verify until expiry; the security improvement is that
   * silent re-login via refresh is now impossible.
   *
   * Per-device sign-out (revoke just this family) would need the
   * client to pass the refresh token. We deliberately default to
   * "everywhere" because the most common signout reason is "phone
   * stolen / left at the restaurant" — losing one device's session
   * shouldn't leave others authenticated.
   */
  signOut: authedProcedure.mutation(async ({ ctx }) => {
    const revoked = await revokeAllForUser(ctx.db, ctx.session.userId);
    return { ok: true, revoked };
  }),

  /**
   * Exchange a refresh token for a fresh access token (and optionally a
   * rotated refresh token).
   *
   * Why this exists: access tokens have a 15-min TTL by design. Without
   * refresh, anyone using the Mini App longer than that hits
   * `auth.errors.required` on every mutation — exactly the bug
   * production was throwing dozens of times per minute on 2026-05-03.
   *
   * Rotation strategy (M1 minimum-viable):
   *   - Verify the refresh JWT (signature + exp).
   *   - Reload the user + their first active membership to derive the
   *     new access claims (sub / org / mid).
   *   - Issue a NEW access token AND a fresh refresh token (same
   *     family) so the client can keep rotating indefinitely.
   *
   * NOT yet implemented (later milestones): refresh-token revocation
   * tracking, family-blacklisting on suspected reuse, rate limiting.
   * Those are M2 hardening; the priority here is "stop locking users
   * out after 15 minutes".
   */
  refresh: publicProcedure.input(RefreshInputSchema).mutation(async ({ ctx, input }) => {
    enforceRate('refresh', ctx.ip);
    let claims: { sub: string; family: string; jti: string | null };
    try {
      claims = await verifyRefresh(input.refreshToken);
    } catch {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidRefresh' });
    }

    // M1.9 (2026-05-07): consume the tracked refresh token. Three
    // outcomes:
    //   - Tracked + active: marked revoked, we proceed to issue a
    //     rotated successor.
    //   - Tracked + already-revoked: REPLAY — the entire family is
    //     nuked inside consumeRefresh and we throw 401. The legitimate
    //     user re-logs in; the attacker (or stale device) loses
    //     access.
    //   - Untracked: pre-M1.9 jti-less token, OR the tracking row was
    //     wiped (db reset, manual purge). Grandfather: issue a fresh
    //     tracked refresh token, log a warning so we can quantify how
    //     many users are still on legacy tokens. After ~30d (refresh
    //     TTL) all sessions migrate naturally.
    let parentId: string | undefined;
    let family: string | undefined;
    if (claims.jti) {
      try {
        await consumeRefresh(ctx.db, claims.jti, claims.family);
        parentId = claims.jti;
        family = claims.family;
      } catch (err) {
        if (err instanceof RefreshReplayError) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'auth.errors.refreshReplayDetected',
          });
        }
        if (err instanceof RefreshNotFoundError) {
          // Untracked OR expired-by-row. Treat the same as legacy.
          logger.warn(
            { sub: claims.sub, family: claims.family, jti: claims.jti },
            'auth.refresh: jti not found in DB — grandfathering as legacy',
          );
        } else {
          throw err;
        }
      }
    } else {
      // M3.9: demoted from info → debug. Legacy-token refresh is the
      // EXPECTED path during the rollout window after we added jti
      // tracking; logging at info clutters the journal with one line
      // per refresh for users on the older bundle. The interesting
      // case (replay-detected) still logs at warn above.
      logger.debug(
        { sub: claims.sub, family: claims.family },
        'auth.refresh: legacy jti-less token — issuing tracked successor',
      );
    }

    const user = await ctx.db.query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.id, claims.sub),
    });
    if (!user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.userMissing' });
    }
    const member = await ctx.db.query.members.findFirst({
      where: (m, { eq: eq2, and: and2 }) =>
        and2(eq2(m.userId, user.id), eq2(m.status, 'active')),
    });
    if (!member) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.noMembership' });
    }
    const session = await buildSessionPayload(ctx.db, user.id, member.id, member.orgId);
    const accessToken = await signAccess({
      sub: user.id,
      org: session.member.orgId,
      mid: member.id,
    });
    // Issue the rotated successor. When `parentId` + `family` are set
    // we're chaining to the consumed row; otherwise we start a fresh
    // family (legacy-token migration path).
    const issued = await issueRefresh(ctx.db, {
      userId: user.id,
      family,
      parentId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const refreshExpiresAt = issued.expiresAt.toISOString();
    return {
      tokens: {
        accessToken,
        refreshToken: issued.token,
        accessExpiresAt,
        refreshExpiresAt,
      },
      session,
    };
  }),
});

async function buildSessionPayload(
  db: DB,
  userId: string,
  memberId: string,
  orgId: string,
): Promise<Session> {
  const user = await db.query.users.findFirst({ where: (u, { eq: eq2 }) => eq2(u.id, userId) });
  const org = await db.query.organizations.findFirst({ where: (o, { eq: eq2 }) => eq2(o.id, orgId) });
  const member = await db.query.members.findFirst({ where: (m, { eq: eq2 }) => eq2(m.id, memberId) });
  if (!user || !org || !member) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'auth.errors.sessionStale' });
  }
  // Permissions and roles first — we need to know whether the member
  // is an admin (bypass) before we decide which stores they see.
  // Bindings now also expose scopeType + scopeId so we can compute
  // per-store rank (C1, 2026-05-06) and per-store admin set (C2).
  const bindings = await db
    .select({
      role: s.roles,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(
      and(
        eq(s.memberRoleBindings.memberId, memberId),
        or(
          isNull(s.memberRoleBindings.expiresAt),
          gt(s.memberRoleBindings.expiresAt, new Date()),
        ),
      ),
    );
  // `super_admin` is used by a handful of destructive maintenance gates;
  // it is meaningful only from a global role binding.
  const roleSlugs = bindings
    .filter((b) => b.role.slug !== 'super_admin' || b.scopeType === 'global')
    .map((b) => b.role.slug);
  const roleIds = bindings.map((b) => b.role.id);
  const globalRoleIds = new Set(
    bindings.filter((b) => b.scopeType === 'global').map((b) => b.role.id),
  );
  // Highest rank held by this member. Used by the FE to gate role
  // grant UI: an admin can only see + offer roles strictly below
  // their own rank. The server enforces the same rule on grantRole;
  // this is purely UX.
  const myMaxRank = bindings.reduce((m, b) => (b.role.rank > m ? b.role.rank : m), 0);
  // C1 (2026-05-06): per-store rank, store-scoped bindings only.
  // The FE combines this with `myMaxRank` (which already includes
  // global rank) to get effective rank in a given store via
  //   max(globalMax, storeRanks[storeId] ?? 0)
  // We don't pre-mix global rank in here so the FE can tell a
  // "store-scoped manager-of-A" apart from a "global admin who also
  // has manager-of-A" when displaying the org chart.
  const storeRanks: Record<string, number> = {};
  for (const b of bindings) {
    if (b.scopeType === 'store' && b.scopeId) {
      const cur = storeRanks[b.scopeId] ?? 0;
      if (b.role.rank > cur) storeRanks[b.scopeId] = b.role.rank;
    }
  }
  const perms =
    roleIds.length > 0
      ? await db.query.rolePermissions.findMany({
          where: (rp, { inArray }) => inArray(rp.roleId, roleIds),
        })
      : [];
  // The client receives a flat permission set for feature affordances.
  // `org.admin` is the one exception: it is an organization-wide bypass,
  // so it can only originate from a global role binding.
  const permKeys = new Set(
    perms
      .filter(
        (p) => p.permissionKey !== 'org.admin' || globalRoleIds.has(p.roleId),
      )
      .map((p) => p.permissionKey),
  );

  // Per-member overrides (added 2026-05-05, migration 0008).
  //
  // Two passes — `allow` first (additive), then `deny` (subtractive)
  // so deny always wins on conflict. Expired overrides are filtered
  // server-side: cheaper than a per-request cron sweep.
  //
  // M0 simplification: store-scoped overrides land in the same
  // permission set regardless of which store the request targets.
  // Per-store gating moves to a request-time check when the
  // store-scope middleware grows; the schema is forward-compatible.
  const overrides = await db
    .select({
      permissionKey: s.memberPermissionOverrides.permissionKey,
      effect: s.memberPermissionOverrides.effect,
      scopeType: s.memberPermissionOverrides.scopeType,
      scopeId: s.memberPermissionOverrides.scopeId,
    })
    .from(s.memberPermissionOverrides)
    .where(
      and(
        eq(s.memberPermissionOverrides.memberId, memberId),
        // Either no expiry, or expiry is in the future. Mirrors the SQL
        // pattern Postgres uses for soft-expiring rows without a sweeper.
        or(
          isNull(s.memberPermissionOverrides.expiresAt),
          gt(s.memberPermissionOverrides.expiresAt, new Date()),
        ),
      ),
    );
  // Defensive `o.permissionKey` truthiness check (audit 2026-05-05) —
  // the column is FK + NOT NULL so this should always be a non-empty
  // string, but a malformed row from a future migration bug shouldn't
  // pollute permKeys with `''` or `undefined`.
  //
  // We collapse global + store-scoped overrides into the flat permKeys
  // set here for back-compat with old code paths. Per-store evaluation
  // happens via `effectivePermissionsForStore` at command time. The
  // organization-wide `org.admin` marker is never collapsed from a
  // store scope; for computing `adminStoreIds` below we keep originals.
  for (const o of overrides) {
    if (
      o.effect === 'allow' &&
      o.permissionKey &&
      (o.permissionKey !== 'org.admin' || o.scopeType === 'global')
    ) {
      permKeys.add(o.permissionKey);
    }
  }
  for (const o of overrides) {
    if (
      o.effect === 'deny' &&
      o.permissionKey &&
      (o.permissionKey !== 'org.admin' || o.scopeType === 'global')
    ) {
      permKeys.delete(o.permissionKey);
    }
  }

  // `users.manage` is store-manager authority too. Only the explicit
  // org-tier marker grants visibility over every store in the session.
  const isOrgAdmin = permKeys.has('org.admin');

  // Scope stores: org admins see ALL active stores in the org. Regular
  // staff see ONLY stores they're explicitly assigned to. This is the
  // multi-store isolation guarantee — prevents store A's staff from
  // seeing store B's data in their session.stores list.
  let storeRows: Array<{ id: string; name: string; code: string | null; isActive: boolean; sortIndex: number }>;
  if (isOrgAdmin) {
    storeRows = await db
      .select({
        id: s.stores.id,
        name: s.stores.name,
        code: s.stores.code,
        isActive: s.stores.isActive,
        sortIndex: s.stores.sortIndex,
      })
      .from(s.stores)
      .where(and(eq(s.stores.orgId, orgId), eq(s.stores.isActive, true)))
      .orderBy(s.stores.sortIndex);
  } else {
    // Non-admin: union of two scope sources (added 2026-05-05 — see
    // storeScope.getActorStoreIds for the same logic, and migration
    // 0007 for how existing global manager bindings got fanned out).
    //   (1) member_store_assignments rows  — explicit "works here"
    //   (2) member_role_bindings (scope_type='store') — role grant
    // Both are valid grants of "you can act on store X". A manager
    // granted "manager of store B" sees store B even if MSA is empty.
    const [msaStores, scopedStores] = await Promise.all([
      db
        .select({
          id: s.stores.id,
          name: s.stores.name,
          code: s.stores.code,
          isActive: s.stores.isActive,
          sortIndex: s.stores.sortIndex,
        })
        .from(s.stores)
        .innerJoin(
          s.memberStoreAssignments,
          eq(s.memberStoreAssignments.storeId, s.stores.id),
        )
        .where(
          and(
            eq(s.stores.orgId, orgId),
            eq(s.stores.isActive, true),
            eq(s.memberStoreAssignments.memberId, memberId),
          ),
        ),
      db
        .select({
          id: s.stores.id,
          name: s.stores.name,
          code: s.stores.code,
          isActive: s.stores.isActive,
          sortIndex: s.stores.sortIndex,
        })
        .from(s.stores)
        .innerJoin(
          s.memberRoleBindings,
          eq(s.memberRoleBindings.scopeId, s.stores.id),
        )
        .where(
          and(
            eq(s.stores.orgId, orgId),
            eq(s.stores.isActive, true),
            eq(s.memberRoleBindings.memberId, memberId),
            eq(s.memberRoleBindings.scopeType, 'store'),
            or(
              isNull(s.memberRoleBindings.expiresAt),
              gt(s.memberRoleBindings.expiresAt, new Date()),
            ),
          ),
        ),
    ]);
    const seen = new Set<string>();
    storeRows = [...msaStores, ...scopedStores]
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .sort((a, b) => a.sortIndex - b.sortIndex);
  }

  // C2 (2026-05-06): compute the set of stores the actor administers.
  // A store-scoped manager who has `users.invite` only in Store A must
  // not be able to invite into Store B; the FE filters its store
  // pickers against this list and the server gates writes via
  // `getActorAdminStoreIds`. We compute it here so the session payload
  // is the single source of truth — no extra round trip per UI render.
  //
  // Algorithm: walk role-bindings + non-expired overrides, look for any
  // of the three admin-tier perm keys, and bucket by scope. A global
  // grant of any of those perms means "admin everywhere" — we resolve
  // that to the full active-store list for the org so the FE can use
  // a uniform `Set<storeId>` lookup without special-casing.
  const ADMIN_PERM_KEYS = new Set([
    'users.manage',
    'users.invite',
    'users.grant_role',
  ]);
  const rolePermsByRole = new Map<string, Set<string>>();
  for (const rp of perms) {
    const set = rolePermsByRole.get(rp.roleId) ?? new Set<string>();
    set.add(rp.permissionKey);
    rolePermsByRole.set(rp.roleId, set);
  }
  let isGlobalAdminPerm = false;
  const storeAdminSet = new Set<string>();
  for (const b of bindings) {
    const rolePerms = rolePermsByRole.get(b.role.id);
    if (!rolePerms) continue;
    let grantsAdmin = false;
    for (const k of ADMIN_PERM_KEYS) {
      if (rolePerms.has(k)) { grantsAdmin = true; break; }
    }
    if (!grantsAdmin) continue;
    if (b.scopeType === 'global') isGlobalAdminPerm = true;
    else if (b.scopeType === 'store' && b.scopeId) storeAdminSet.add(b.scopeId);
  }
  for (const o of overrides) {
    if (!o.permissionKey || !ADMIN_PERM_KEYS.has(o.permissionKey)) continue;
    if (o.effect === 'allow') {
      if (o.scopeType === 'global') isGlobalAdminPerm = true;
      else if (o.scopeType === 'store' && o.scopeId) storeAdminSet.add(o.scopeId);
    } else {
      // deny shrinks the admin set
      if (o.scopeType === 'global') isGlobalAdminPerm = false;
      else if (o.scopeType === 'store' && o.scopeId) storeAdminSet.delete(o.scopeId);
    }
  }
  const adminStoreIds: string[] = isGlobalAdminPerm
    ? // Global admin authority → every active store in the org.
      // We already loaded `storeRows` above for non-admins as a UNION
      // of MSA + scoped bindings, but that's the set of stores the
      // actor BELONGS to (read-side). The admin set below is ALL
      // active stores in the org — what an org-wide admin can manage,
      // regardless of where they're personally assigned.
      (await db
        .select({ id: s.stores.id })
        .from(s.stores)
        .where(and(eq(s.stores.orgId, orgId), eq(s.stores.isActive, true)))
      ).map((r) => r.id)
    : [...storeAdminSet];

  // Onboarding hint: the FE should show the name-confirm screen when
  // the user hasn't yet locked their displayName. Either flow reaches
  // this state:
  //   1. Self sign-up via Telegram (user has displayName from Telegram
  //      but never confirmed it in our app).
  //   2. Admin invite via memberInviteByTgId (placeholder name `tg:NNN`).
  const needsOnboarding = !user.displayNameLocked;

  return {
    user: {
      id: user.id,
      displayName: user.displayName,
      displayNameLocked: user.displayNameLocked,
      avatarUrl: user.avatarUrl,
      locale: (user.locale ?? 'en') as Session['user']['locale'],
      // M3.45 (2026-05-22): bilingual display preference. Null when
      // unset (default — single-language UI). Otherwise one of the
      // 4-locale enum, drives product-name rendering and per-vendor
      // copy-template language.
      secondaryLocale: (user.secondaryLocale ?? null) as
        | Session['user']['locale']
        | null,
      tgUsername: user.tgUsername,
    },
    member: {
      memberId: member.id,
      orgId: org.id,
      orgSlug: org.slug,
      orgName: org.name,
      status: member.status,
      // M1.17 (2026-05-08): currency + tax exposed on session so the
      // FE can format money + display tax info without a round-trip
      // per page. Snapshot-from-DB at login — operators should NEVER
      // flip currency mid-life, so this stays valid for the session
      // lifetime.
      currency: org.currency ?? 'UZS',
      taxRatePct: org.taxRatePct ?? '0',
      pricesIncludeTax: org.pricesIncludeTax ?? true,
    },
    stores: storeRows.map((st) => ({
      id: st.id,
      name: st.name,
      code: st.code,
      isActive: st.isActive,
    })),
    permissions: [...permKeys],
    roleSlugs,
    myMaxRank,
    storeRanks,
    adminStoreIds,
    needsOnboarding,
  };
}
