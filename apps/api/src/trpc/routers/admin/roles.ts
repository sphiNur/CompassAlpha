/** Roles and permissions: the role catalog, and granting and revoking roles. */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  ADMIN_RANK,
  GrantRoleInputSchema,
  UuidSchema,
  CONTROL_CHARS_MESSAGE,
  noControlChars,
  RevokeRoleInputSchema,
} from '@compass/contracts';
import { SLUG_MESSAGE, SLUG_RE } from '@compass/contracts/limits';
import { authedProcedure, withUniqueKey } from '../../trpc';
import { hub } from '../../../realtime/hub';
import { effectiveGlobalPermissions } from '../../../services/storeScope';
import {
  bindingIsLive,
  countAdminsInOrg,
  getActorMaxGlobalRank,
  grantBinding,
  getActorMaxRankInStore,
} from '../../../services/adminAuthority';
import { requireAdmin, requireOrgAdmin, requireOneOf, assertHoldsKeys } from './guards';
import { broadcastPeople } from './notify';
import {
  getActorAdminStoreIds,
  notAdminOfStore,
  getAdminReadScope,
  visibleMemberIds,
} from './scope';
import {
  exemptFromKeyCheck,
  assertCanGrantTo,
  rolePassOnScopes,
  keyPassOnScopes,
  assertCanPassOnRole,
  PASS_ON_NOWHERE,
} from './grants';
import { auditAdmin } from '../../../services/adminAudit';

export const roleProcedures = {
  // ============ ROLES ============

  roleList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const roles = await tx
        .select({
          id: s.roles.id,
          slug: s.roles.slug,
          name: s.roles.name,
          description: s.roles.description,
          isBuiltIn: s.roles.isBuiltIn,
          rank: s.roles.rank,
        })
        .from(s.roles)
        .where(eq(s.roles.orgId, orgId))
        .orderBy(desc(s.roles.rank));
      const counts = await tx
        .select({
          roleId: s.rolePermissions.roleId,
          n: sql<number>`count(*)::int`,
        })
        .from(s.rolePermissions)
        .innerJoin(s.roles, eq(s.roles.id, s.rolePermissions.roleId))
        .where(eq(s.roles.orgId, orgId))
        .groupBy(s.rolePermissions.roleId);
      const countByRole = new Map(counts.map((c) => [c.roleId, c.n]));
      const passOn = await rolePassOnScopes(tx, ctx, roles);
      return roles.map((r) => ({
        ...r,
        permissionCount: countByRole.get(r.id) ?? 0,
        passOn: passOn.get(r.id) ?? PASS_ON_NOWHERE,
      }));
    });
  }),

  /**
   * Per-role permission breakdown — used by the new Permissions screen.
   * Returns the role + the explicit list of permission keys it grants.
   */
  roleDetail: authedProcedure
    .input(z.object({ roleSlug: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const role = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.orgId, orgId), eq2(r.slug, input.roleSlug)),
        });
        if (!role) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
        }
        const perms = await tx
          .select({ key: s.rolePermissions.permissionKey })
          .from(s.rolePermissions)
          .where(eq(s.rolePermissions.roleId, role.id));
        // B1 (2026-05-06): assignees grouped by binding scope.
        //   - global bindings → "Org-level" bucket
        //   - store bindings → one bucket per store
        // Powers the "who has this role where" drill-down in the
        // Roles screen so a chain owner can answer "who runs each
        // store?" at a glance.
        const bindings = await tx
          .select({
            bindingId: s.memberRoleBindings.id,
            memberId: s.memberRoleBindings.memberId,
            scopeType: s.memberRoleBindings.scopeType,
            scopeId: s.memberRoleBindings.scopeId,
            displayName: s.users.displayName,
            avatarUrl: s.users.avatarUrl,
            tgUsername: s.users.tgUsername,
            storeName: s.stores.name,
            status: s.members.status,
          })
          .from(s.memberRoleBindings)
          .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
          .innerJoin(s.users, eq(s.users.id, s.members.userId))
          // Left join: global bindings have no store, but we still
          // want one row per binding (the FE buckets them into
          // "Org-level" when storeName is null).
          .leftJoin(s.stores, eq(s.stores.id, s.memberRoleBindings.scopeId))
          // ADM1-20 (2026-11-10): suspended holders too, marked. They
          // keep the role and block deleting it, and the list showed
          // nobody. ADM1-04: lapsed grants hold nothing and are left out.
          .where(
            and(
              eq(s.memberRoleBindings.roleId, role.id),
              eq(s.members.orgId, orgId),
              bindingIsLive(),
            ),
          );
        // 2026-10-21 CA-17: outside org admins, holders are limited to the
        // actor's stores — store bindings there, and global bindings of
        // members who belong to one of those stores.
        const scope = await getAdminReadScope(tx, ctx.session!);
        const visible = scope ? await visibleMemberIds(tx, scope, ctx.session!.memberId) : null;
        const shown =
          scope && visible
            ? bindings.filter((b) =>
                b.scopeType === 'store'
                  ? !!b.scopeId && scope.has(b.scopeId)
                  : visible.has(b.memberId),
              )
            : bindings;
        // ADM1-07 / ADM1-20: every live binding, suspended holders too:
        // the count roleDelete and a rank move across ADMIN_RANK refuse
        // on. Only for org admins, who alone may do either.
        const [counted] =
          scope === null
            ? await tx
                .select({ n: sql<number>`count(*)::int` })
                .from(s.memberRoleBindings)
                .where(and(eq(s.memberRoleBindings.roleId, role.id), bindingIsLive()))
            : [];
        return {
          id: role.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          isBuiltIn: role.isBuiltIn,
          rank: role.rank,
          permissions: perms.map((p) => p.key),
          bindingCount: counted?.n ?? null,
          assignees: shown.map((b) => ({
            bindingId: b.bindingId,
            memberId: b.memberId,
            displayName: b.displayName,
            avatarUrl: b.avatarUrl,
            tgUsername: b.tgUsername,
            scopeType: b.scopeType as 'global' | 'store',
            scopeId: b.scopeId,
            storeName: b.storeName,
            status: b.status,
          })),
        };
      });
    }),

  /**
   * Full permission catalog — global static dictionary keyed by
   * `domain.action`. Powers the role-permission editor matrix
   * (added 2026-05-05). Returns rows even when the actor's org has
   * never used a key, since the dictionary is org-independent.
   */
  permissionList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const rows = await tx
        .select({
          key: s.permissions.key,
          description: s.permissions.description,
        })
        .from(s.permissions)
        .orderBy(s.permissions.key);
      // ADM1-07: where the actor may pass each key on, as roleList's
      // `passOn` says for roles.
      const passOn = await keyPassOnScopes(
        tx,
        ctx,
        rows.map((r) => r.key),
      );
      return rows.map((r) => ({ ...r, passOn: passOn.get(r.key) ?? PASS_ON_NOWHERE }));
    });
  }),

  /**
   * Create a CUSTOM role (added 2026-05-05).
   *
   * Rules:
   *   - slug must be unique within the org and lowercase-kebab-only
   *   - rank must be STRICTLY less than the actor's max rank, otherwise
   *     an admin (rank 80) could create a rank-99 role and grant it to
   *     themselves, escalating to super_admin
   *   - permissionKeys must all exist in the global permissions
   *     dictionary (silent-drop prevents typos from creating roles
   *     that look right but actually grant nothing)
   *   - is_built_in is always FALSE for created roles — built-ins are
   *     shipped only via the seed script
   *
   * Idempotent on slug — if a role with this slug already exists in
   * the org, returns its id without creating a duplicate. (Custom-
   * roles UI re-firing create on a slow network is a real risk.)
   */
  roleCreate: authedProcedure
    .input(
      z.object({
        slug: z.string().min(1).max(64).regex(SLUG_RE, SLUG_MESSAGE.role),
        name: z.string().min(1).max(100).refine(noControlChars, CONTROL_CHARS_MESSAGE),
        description: z.string().max(500).optional().nullable(),
        rank: z.number().int().min(1).max(99),
        permissionKeys: z.array(z.string().min(1).max(100)).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // M3.3: role catalog is org-wide; only org.admin can mint roles.
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const actorRank = await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
        if (input.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        if (!(await exemptFromKeyCheck(tx, ctx))) {
          // DX-ADM-2: a role applies in every store, so only keys the
          // actor holds org-wide may go into it.
          assertHoldsKeys(
            await effectiveGlobalPermissions(tx, ctx.session!.memberId),
            input.permissionKeys,
          );
        }
        // Idempotency: if the slug already exists, return it.
        const existing = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.orgId, orgId), eq2(r.slug, input.slug)),
        });
        if (existing) {
          return { id: existing.id, created: false };
        }
        // ADM-25 (2026-10-30): two creates of one slug at once both
        // passed the check above and the loser hit the unique index as a 500.
        const [created] = await withUniqueKey(
          tx
            .insert(s.roles)
            .values({
              orgId,
              slug: input.slug,
              name: input.name,
              description: input.description ?? null,
              rank: input.rank,
              isBuiltIn: false,
            })
            .returning(),
          'admin.errors.roleSlugTaken',
        );
        if (input.permissionKeys.length > 0) {
          // Filter against the dictionary so a typo doesn't silently
          // create a half-broken role.
          const validKeys = await tx.query.permissions.findMany({
            where: (p, { inArray: ia }) => ia(p.key, input.permissionKeys),
          });
          if (validKeys.length > 0) {
            await tx
              .insert(s.rolePermissions)
              .values(validKeys.map((p) => ({ roleId: created!.id, permissionKey: p.key })))
              .onConflictDoNothing();
          }
        }
        await auditAdmin(tx, ctx, 'admin.role.create', 'role', created!.id, input);
        broadcastPeople(orgId);
        return { id: created!.id, created: true };
      });
    }),

  /**
   * Edit a role's mutable fields. Built-in roles are partially locked:
   *   - slug is immutable (so existing bindings keep working)
   *   - rank is immutable (so the rank-gate semantics stay stable)
   *   - name / description / permissionKeys CAN change (admins
   *     legitimately want to rename "manager" or add a permission)
   * For custom roles, all fields editable except slug.
   *
   * permissionKeys (when provided) is treated as a FULL replacement.
   */
  roleUpdate: authedProcedure
    .input(
      z.object({
        roleId: UuidSchema,
        name: z.string().min(1).max(100).refine(noControlChars, CONTROL_CHARS_MESSAGE).optional(),
        description: z.string().max(500).optional().nullable(),
        rank: z.number().int().min(1).max(99).optional(),
        permissionKeys: z.array(z.string().min(1).max(100)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const role = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.id, input.roleId), eq2(r.orgId, orgId)),
        });
        if (!role) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
        }
        const actorRank = await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
        // Rank gate — both the existing rank AND the proposed new rank
        // must be strictly below the actor's rank. Without the existing-
        // rank check, an admin (80) could "edit" super_admin (100) by
        // setting its rank to 50 and then grant it to themselves.
        if (role.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        if (input.rank !== undefined && input.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        // ADM-22 (2026-10-30): a new rank for a built-in role answered ok
        // and was silently ignored.
        if (input.rank !== undefined && role.isBuiltIn && input.rank !== role.rank) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'admin.errors.builtinRankLocked' });
        }
        // ADM1-02 (2026-11-09): the tier decides where a role is bound —
        // from ADMIN_RANK up only globally, below it only in stores
        // (grantRole). Moving a held role across it left its bindings in
        // the wrong scope: store bindings that outranked the org admins in
        // their store and counted as admins, or global bindings of a store
        // role (what migration 0007 cleaned up). Every binding counts, as
        // for roleDelete: a suspended member's comes back with them.
        const orgTier = (rank: number) => rank >= ADMIN_RANK;
        if (input.rank !== undefined && orgTier(input.rank) !== orgTier(role.rank)) {
          // ADM1-04: a lapsed binding holds nothing.
          const [held] = await tx
            .select({ id: s.memberRoleBindings.id })
            .from(s.memberRoleBindings)
            .where(and(eq(s.memberRoleBindings.roleId, role.id), bindingIsLive()))
            .limit(1);
          if (held) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'admin.errors.rankTierChangeHasBindings',
              cause: { context: { rank: ADMIN_RANK } },
            });
          }
        }
        const patch: Record<string, unknown> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description;
        // Built-ins keep their rank (anchors the rank-gate ladder).
        if (input.rank !== undefined && !role.isBuiltIn) patch.rank = input.rank;
        if (input.permissionKeys !== undefined) {
          // Keys the role already has may stay; only additions are gated.
          const current = await tx
            .select({ key: s.rolePermissions.permissionKey })
            .from(s.rolePermissions)
            .where(eq(s.rolePermissions.roleId, role.id));
          const had = new Set(current.map((r) => r.key));
          if (!(await exemptFromKeyCheck(tx, ctx))) {
            assertHoldsKeys(
              await effectiveGlobalPermissions(tx, ctx.session!.memberId),
              input.permissionKeys.filter((key) => !had.has(key)),
            );
          }
        }
        if (Object.keys(patch).length > 0) {
          await tx.update(s.roles).set(patch).where(eq(s.roles.id, role.id));
        }
        if (input.permissionKeys !== undefined) {
          // Replace permissions atomically: delete existing, insert new.
          await tx.delete(s.rolePermissions).where(eq(s.rolePermissions.roleId, role.id));
          if (input.permissionKeys.length > 0) {
            const validKeys = await tx.query.permissions.findMany({
              where: (p, { inArray: ia }) => ia(p.key, input.permissionKeys!),
            });
            if (validKeys.length > 0) {
              await tx
                .insert(s.rolePermissions)
                .values(validKeys.map((p) => ({ roleId: role.id, permissionKey: p.key })))
                .onConflictDoNothing();
            }
          }
        }
        await auditAdmin(tx, ctx, 'admin.role.update', 'role', role.id, input);
        broadcastPeople(orgId);
        return { ok: true };
      });
    }),

  /**
   * Delete a CUSTOM role. Built-ins are not deletable (they anchor the
   * rank ladder + are referenced by seeded fixtures). Roles with active
   * member bindings are blocked — admin must revoke first, otherwise
   * we'd orphan permissions on real users.
   */
  roleDelete: authedProcedure
    .input(z.object({ roleId: UuidSchema }))
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const role = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.id, input.roleId), eq2(r.orgId, orgId)),
        });
        if (!role) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
        }
        if (role.isBuiltIn) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.cannotDeleteBuiltinRole',
          });
        }
        const actorRank = await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
        if (role.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        // ADM1-04: lapsed bindings do not keep a role; they go with it
        // (the foreign key cascades).
        const bindings = await tx
          .select({ id: s.memberRoleBindings.id })
          .from(s.memberRoleBindings)
          .where(and(eq(s.memberRoleBindings.roleId, role.id), bindingIsLive()));
        if (bindings.length > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'admin.errors.roleHasBindings',
          });
        }
        // Hard delete — `auth.role_permissions` cascades from `auth.roles`.
        // R2-ADM-3: audit first, while the role's name can still be read.
        await auditAdmin(tx, ctx, 'admin.role.delete', 'role', role.id, input);
        await tx.delete(s.roles).where(eq(s.roles.id, role.id));
        broadcastPeople(orgId);
        return { ok: true };
      });
    }),

  grantRole: authedProcedure.input(GrantRoleInputSchema).mutation(async ({ ctx, input }) => {
    // Accept either the legacy coarse `users.manage` or the new
    // granular `users.grant_role` permission.
    requireOneOf(ctx.session!.permissions, ['users.grant_role', 'users.manage']);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const member = await tx.query.members.findFirst({
        where: (m, { eq: eq2, and: and2 }) =>
          and2(eq2(m.orgId, orgId), eq2(m.userId, input.userId)),
      });
      if (!member) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
      }
      // ADM1-08: as the invite path does (ADM-19), a suspended member is
      // reactivated before they are given anything.
      if (member.status !== 'active') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.memberInactiveReactivateFirst',
        });
      }
      const role = await tx.query.roles.findFirst({
        where: (r, { eq: eq2, and: and2 }) =>
          and2(eq2(r.orgId, orgId), eq2(r.slug, input.roleSlug)),
      });
      if (!role) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
      }

      // Global role bindings are organization-wide authority. Require the
      // dedicated marker before creating one; `users.manage` also belongs to
      // store managers and is therefore not sufficient here.
      if (input.scopeType === 'global') {
        requireOrgAdmin(ctx.session!.permissions);
      }

      // Roles at the organization tier must never be attached to one store.
      // This is the inverse of the pre-existing low-rank rule below and
      // prevents a scoped admin/super_admin binding from leaking org.admin.
      if (role.rank >= ADMIN_RANK && input.scopeType !== 'global') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.orgAdminMustBeGlobal',
        });
      }

      // Custom roles can carry org.admin too. Guard by the permission rather
      // than rank as defense in depth for malformed or legacy role rows.
      const roleHasOrgAdmin = await tx.query.rolePermissions.findFirst({
        where: (rp, { eq: eq2, and: and2 }) =>
          and2(eq2(rp.roleId, role.id), eq2(rp.permissionKey, 'org.admin')),
      });
      if (roleHasOrgAdmin && input.scopeType !== 'global') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.orgAdminMustBeGlobal',
        });
      }
      if (roleHasOrgAdmin) {
        requireOrgAdmin(ctx.session!.permissions);
      }

      // STORE-SCOPE REQUIREMENT (added 2026-05-05).
      //
      // Roles below admin tier (rank < 80) are inherently per-store —
      // a manager manages SPECIFIC stores; a purchaser/staff WORKS at
      // SPECIFIC stores. We refuse to create global bindings for them
      // because that's the path by which a "manager of everywhere"
      // accidentally lands in the DB and the Approval queue starts
      // showing every org's session to every manager (audit found
      // 2026-05-05 — see docs/role-design-2026-05-05.md). admin (80)
      // and super_admin (100) stay 'global' since they ARE org-tier.
      if (role.rank < ADMIN_RANK && input.scopeType !== 'store') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.scopeStoreIdRequired',
        });
      }

      // SECURITY (2026-05-04): if the binding is store-scoped, verify
      // the store belongs to the actor's org. Without this an admin in
      // org A could grant a role scoped to a store in org B by passing
      // its UUID — cross-tenant injection.
      if (input.scopeType === 'store') {
        if (!input.scopeId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.scopeStoreIdRequired',
          });
        }
        const targetStore = await tx.query.stores.findFirst({
          where: (st, { eq: eq2, and: and2 }) =>
            and2(eq2(st.id, input.scopeId!), eq2(st.orgId, orgId)),
        });
        if (!targetStore) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'admin.errors.storeNotFound',
          });
        }
      }

      // C2 (2026-05-06): store-scoped admins can only manage members
      // of THEIR stores. A "manager of Store A" who tries to grant
      // "staff of Store B" must be refused: they have no authority
      // there. Global admins pass through (their adminStoreIds is
      // the full org list).
      //
      // We check this BEFORE the rank gate so the FORBIDDEN message
      // points at the real problem — if a store-scoped manager is
      // trying to act on a foreign store, "you don't manage that
      // store" is more useful than "your rank is too low."
      if (input.scopeType === 'store' && input.scopeId) {
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowed.includes(input.scopeId)) {
          throw await notAdminOfStore(tx, orgId, [input.scopeId]);
        }
      }

      // C1 (2026-05-06): rank gate — "no equal/higher grants", but
      // evaluated IN THE SCOPE the binding is being created in.
      //
      //   - 'global' grant → getActorMaxGlobalRank: the actor's global
      //     bindings alone (F8, ADM1-01). Counting their store bindings
      //     let a legacy store-scoped super_admin grant `admin` org-wide.
      //   - 'store' grant → use getActorMaxRankInStore: a manager rank-50
      //     in Store A cannot grant rank-50 INTO Store A, AND cannot
      //     grant ANYTHING into Store B (where their effective rank is 0
      //     unless they hold a global binding).
      //
      // The earlier code used global rank for both branches, which let
      // a store-scoped manager smuggle their authority across stores.
      const actorRank =
        input.scopeType === 'store' && input.scopeId
          ? await getActorMaxRankInStore(tx, orgId, ctx.session!.userId, input.scopeId)
          : await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
      if (role.rank >= actorRank) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.cannotGrantEqualOrHigher',
        });
      }
      // ADM1-08: to someone below the actor there, never to themself.
      await assertCanGrantTo(
        tx,
        ctx,
        member.userId,
        input.scopeType === 'store' && input.scopeId
          ? { type: 'store', storeId: input.scopeId }
          : { type: 'global' },
      );
      // D8: and only a role whose keys the actor holds there.
      await assertCanPassOnRole(
        tx,
        ctx,
        role.id,
        input.scopeType === 'store' ? (input.scopeId ?? null) : null,
      );

      // Idempotency (fixed 2026-05-05): the binding is keyed by member,
      // role and scope, the store included, so "manager of store B" after
      // "manager of store A" is a second binding, not "already exists".
      // ADM-7 (2026-10-30): two grants at once (a double tap) both found
      // no binding and both inserted. Serialise per member + role so the
      // second sees the first.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`grant:${member.id}:${role.id}`}))`,
      );
      // 2026-10-21 audit A-23: the contract checks the format; re-check
      // here so a direct caller can't store Invalid Date (→ 500) or an
      // already-expired grant.
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && !(expiresAt.getTime() > Date.now())) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'admin.errors.invalidExpiresAt' });
      }
      // ADM1-04: a lapsed binding of the same role and scope is renewed;
      // it used to answer "already has this role". RE-ADM-1: the unique
      // index settles a race with the invite paths, which do not take
      // this lock.
      const { outcome, bindingId } = await grantBinding(tx, {
        memberId: member.id,
        roleId: role.id,
        scope:
          input.scopeType === 'store' && input.scopeId
            ? { type: 'store', storeId: input.scopeId }
            : { type: 'global' },
        grantedBy: ctx.session!.userId,
        expiresAt,
      });
      if (outcome === 'held') return { granted: false, bindingId };
      await auditAdmin(tx, ctx, 'admin.role.grant', 'member', member.id, {
        ...input,
        bindingId,
        roleRank: role.rank,
        ...(outcome === 'renewed' ? { renewed: true } : {}),
      });
      // Broadcast so other admins viewing the People section see the
      // new binding without manual refresh.
      hub.publish(orgId, { type: 'people.changed', orgId });
      return { granted: true, bindingId };
    });
  }),

  revokeRole: authedProcedure.input(RevokeRoleInputSchema).mutation(async ({ ctx, input }) => {
    requireOneOf(ctx.session!.permissions, ['users.revoke_role', 'users.manage']);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const binding = await tx
        .select({
          id: s.memberRoleBindings.id,
          memberOrgId: s.members.orgId,
          memberUserId: s.members.userId,
          roleSlug: s.roles.slug,
          roleRank: s.roles.rank,
          scopeType: s.memberRoleBindings.scopeType,
          scopeId: s.memberRoleBindings.scopeId,
        })
        .from(s.memberRoleBindings)
        .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
        .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
        .where(eq(s.memberRoleBindings.id, input.bindingId))
        .limit(1);
      if (binding.length === 0 || binding[0]!.memberOrgId !== orgId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.bindingNotFound' });
      }
      const targetSlug = binding[0]!.roleSlug;
      const targetRank = binding[0]!.roleRank;
      const bindingScopeType = binding[0]!.scopeType;
      const bindingScopeId = binding[0]!.scopeId;
      // Self-protection: don't let an admin revoke their own super_admin /
      // admin roles. The CLI is the escape hatch for true breakage.
      if (
        binding[0]!.memberUserId === ctx.session!.userId &&
        (targetSlug === 'super_admin' || targetSlug === 'admin')
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.cannotRevokeSelfAdmin',
        });
      }
      // ADM1-17 (2026-11-09): a global binding is organisation-wide
      // authority; taking one away needs the global org admin that
      // granting it does. A store manager outranking a legacy low-rank
      // global binding could revoke it in every store at once.
      if (bindingScopeType === 'global') requireOrgAdmin(ctx.session!.permissions);
      // C2 (2026-05-06): if the binding being revoked is store-scoped,
      // the actor must be admin-of-that-store. Without this gate a
      // manager-of-A could revoke a manager-of-B binding and silently
      // demote staff in stores they have no business touching.
      if (bindingScopeType === 'store' && bindingScopeId) {
        // R2-ADM-2: bindings left in an archived store can still be taken away.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId, {
          includeInactive: true,
        });
        if (!allowed.includes(bindingScopeId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
      }
      // C1 (2026-05-06): rank gate — same logic as grant, evaluated in
      // the binding's scope. A manager-rank-50 in Store A revoking a
      // manager-rank-50 in Store A: equal rank, refused. Revoking a
      // staff-rank-10 in Store A: 50 > 10, allowed. Cross-store is
      // already blocked above by the C2 check.
      const actorRank =
        bindingScopeType === 'store' && bindingScopeId
          ? await getActorMaxRankInStore(tx, orgId, ctx.session!.userId, bindingScopeId)
          : await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
      if (targetRank >= actorRank) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.cannotRevokeEqualOrHigher',
        });
      }
      // Last-admin guard. If revoking this binding would drop the
      // org's admin-rank head-count to zero, refuse. Without this an
      // org could end up with no manageable admin (only super_admin
      // could fix from CLI) — a real footgun for a SaaS rollout.
      if (targetRank >= ADMIN_RANK) {
        // Admins left once this binding is gone (the member may hold
        // another admin-rank role and stay one).
        const adminsLeft = await countAdminsInOrg(tx, orgId, { bindingId: input.bindingId });
        if (adminsLeft < 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.cannotRemoveLastAdmin',
          });
        }
      }
      await tx.delete(s.memberRoleBindings).where(eq(s.memberRoleBindings.id, input.bindingId));
      await auditAdmin(tx, ctx, 'admin.role.revoke', 'role_binding', input.bindingId, {
        ...input,
        userId: binding[0]!.memberUserId,
        roleSlug: targetSlug,
        scopeType: bindingScopeType,
        scopeId: bindingScopeId,
      });
      hub.publish(orgId, { type: 'people.changed', orgId });
      return { revoked: true };
    });
  }),
};
