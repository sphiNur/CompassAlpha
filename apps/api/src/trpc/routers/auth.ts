import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { schema as s } from '@compass/db';
import {
  TelegramLoginInputSchema,
  RefreshInputSchema,
  CompleteOnboardingInputSchema,
  type SessionSchema as SessionShape,
} from '@compass/contracts';
import { authedProcedure, publicProcedure, router } from '../trpc';
import { verifyInitData } from '../../services/telegramAuth';
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

export const authRouter = router({
  /** Login via Telegram Mini App initData. */
  telegramLogin: publicProcedure
    .input(TelegramLoginInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceRate('login', ctx.ip);
      if (!env.TELEGRAM_BOT_TOKEN) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'auth.errors.botTokenMissing' });
      }
      const result = verifyInitData(input.initData, env.TELEGRAM_BOT_TOKEN);
      if (!result.ok || !result.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidInitData' });
      }
      const tg = result.user;

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

      const session = await buildSessionPayload(ctx.db, user.id, ensuredMember.id, ensuredMember.orgId);
      const accessToken = await signAccess({ sub: user.id, org: session.member.orgId, mid: ensuredMember.id });
      // M1.9 (2026-05-07): refresh tokens are now tracked in
      // auth.refresh_tokens with rotation lineage + replay detection.
      // issueRefresh inserts a row keyed by the JWT's `jti`; the
      // matching `consumeRefresh` lookup powers signOut + replay defence.
      const issued = await issueRefresh(ctx.db, {
        userId: user.id,
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
      logger.info(
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
  db: NonNullable<Parameters<typeof signAccess>[0]> extends never ? never : import('@compass/db').DB,
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
    .where(eq(s.memberRoleBindings.memberId, memberId));
  const roleSlugs = bindings.map((b) => b.role.slug);
  const roleIds = bindings.map((b) => b.role.id);
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
  const permKeys = new Set(perms.map((p) => p.permissionKey));

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
  // happens via `effectivePermissionsForStore` at command time. For
  // computing `adminStoreIds` below we keep the originals.
  for (const o of overrides) {
    if (o.effect === 'allow' && o.permissionKey) permKeys.add(o.permissionKey);
  }
  for (const o of overrides) {
    if (o.effect === 'deny' && o.permissionKey) permKeys.delete(o.permissionKey);
  }

  const isAdmin = permKeys.has('users.manage');

  // Scope stores: admins see ALL active stores in the org. Regular
  // staff see ONLY stores they're explicitly assigned to. This is the
  // multi-store isolation guarantee — prevents store A's staff from
  // seeing store B's data in their session.stores list.
  let storeRows: Array<{ id: string; name: string; code: string | null; isActive: boolean; sortIndex: number }>;
  if (isAdmin) {
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
      tgUsername: user.tgUsername,
    },
    member: {
      memberId: member.id,
      orgId: org.id,
      orgSlug: org.slug,
      orgName: org.name,
      status: member.status,
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
