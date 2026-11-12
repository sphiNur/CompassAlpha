/**
 * Stores: the list, create, edit, archive and delete, and copying one
 * store's roles to another.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  ADMIN_RANK,
  StoreCreateInputSchema,
  StoreUpdateInputSchema,
  StoreCloneRolesInputSchema,
  StoreDeleteInputSchema,
} from '@compass/contracts';
import { authedProcedure, withUniqueKey } from '../../trpc';
import { hasGlobalOrgAdmin } from '../../../services/orgAdmin';
import {
  bindingIsLive,
  grantBinding,
  getActorMaxRankInStore,
  recipientRefusal,
} from '../../../services/adminAuthority';
import { assertCanAddStore } from '../../../services/subscription';
import { auditChanges } from '../../../services/auditChanges';
import { requireAdmin, requireOrgAdmin } from './guards';
import { broadcastCatalog, broadcastPeople } from './notify';
import { getActorAdminStoreIds, notAdminOfStore, getAdminReadScope } from './scope';
import { orgRowOr404 } from './orgRows';
import { granterOf, missingRoleKey, assertCanPassOnRole } from './grants';
import { roleNameForAudit, auditAdmin } from '../../../services/adminAudit';

export const storeProcedures = {
  // ============ STORES ============

  storeList: authedProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        // SECURITY (2026-05-04): default behavior excludes soft-deleted
        // stores. Previously every storeList call returned them and the
        // FE had no signal to hide. Now: pass `includeArchived: true`
        // to see them (e.g. for a "show archived" toggle in admin).
        // Left-join roles so we can return the default role's slug
        // alongside the store row — saves the FE a second query.
        const rows = await tx
          .select({
            id: s.stores.id,
            name: s.stores.name,
            code: s.stores.code,
            address: s.stores.address,
            timezone: s.stores.timezone,
            isActive: s.stores.isActive,
            // ADM-18 (2026-10-30): archived and paused both read "paused".
            archived: sql<boolean>`${s.stores.deletedAt} IS NOT NULL`,
            createdAt: s.stores.createdAt,
            defaultRoleId: s.stores.defaultRoleId,
            defaultRoleSlug: s.roles.slug,
            defaultRoleName: s.roles.name,
          })
          .from(s.stores)
          .leftJoin(s.roles, eq(s.roles.id, s.stores.defaultRoleId))
          .where(
            and(
              eq(s.stores.orgId, orgId),
              ...(includeArchived ? [] : [eq(s.stores.isActive, true)]),
            ),
          )
          .orderBy(s.stores.name);
        // 2026-10-21 CA-17: a non-org-admin lists only the stores they
        // administer (active ones — archived stores are org-admin work).
        const scope = await getAdminReadScope(tx, ctx.session!);
        return scope ? rows.filter((r) => scope.has(r.id)) : rows;
      });
    }),

  storeCreate: authedProcedure.input(StoreCreateInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: creating a store is org-level (adds to the chain).
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      await assertCanAddStore(tx, orgId);
      const [created] = await withUniqueKey(
        tx
          .insert(s.stores)
          .values({
            orgId,
            name: input.name,
            code: input.code ?? null,
            address: input.address ?? null,
            timezone: input.timezone ?? null,
          })
          .returning(),
        'admin.errors.codeTaken',
      );
      await auditAdmin(tx, ctx, 'admin.store.create', 'store', created!.id, input);
      broadcastCatalog(orgId, 'store');
      return { id: created!.id };
    });
  }),

  storeUpdate: authedProcedure.input(StoreUpdateInputSchema).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // M3.3 (2026-05-15): per-store admin gate (C2 pattern). Before
      // this the procedure was reachable by any actor with
      // `users.manage`, so a manager-of-A could pass storeId=B and
      // rename Store B. Mirrors the gate already present on
      // memberAssignStore / memberDetachFromStore.
      //
      // 2026-10-21 audit CA-08: pausing / reactivating a store is
      // org-tier (like storeDelete). And because getActorAdminStoreIds
      // lists only ACTIVE stores, a paused store could never be updated
      // again; a global org admin therefore skips the per-store list
      // (the org match on `existing` below still applies).
      if (input.isActive !== undefined) requireOrgAdmin(ctx.session!.permissions);
      const isOrgAdmin = await hasGlobalOrgAdmin(tx, ctx.session!.memberId);
      if (!isOrgAdmin) {
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowed.includes(input.storeId)) {
          throw await notAdminOfStore(tx, orgId, [input.storeId]);
        }
      }
      const existing = await orgRowOr404(
        tx,
        s.stores,
        orgId,
        input.storeId,
        'admin.errors.storeNotFound',
      );
      // ADM2-36: typed by the table, as the catalog's edits.
      const patch: Partial<typeof s.stores.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.code !== undefined) patch.code = input.code;
      if (input.address !== undefined) patch.address = input.address;
      if (input.timezone !== undefined) patch.timezone = input.timezone;
      if (input.isActive !== undefined) {
        if (!isOrgAdmin) {
          // Session said org.admin but no GLOBAL grant backs it.
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.missingPermission',
            cause: { missingPermission: 'org.admin' },
          });
        }
        patch.isActive = input.isActive;
        if (input.isActive && !existing.isActive) {
          // 2026-10-21 audit CA-08 / CA-18: reactivation takes a store
          // seat on the plan, and also restores an archived store
          // (storeDelete sets deletedAt alongside isActive=false).
          await assertCanAddStore(tx, orgId);
          patch.deletedAt = null;
        }
      }
      // D3: defaultRoleSlug. `null` clears; a string resolves to a
      // role-id (within the actor's org so cross-tenant slugs can't
      // sneak in). We accept by slug rather than role-id to keep the
      // contract human-readable in the FE form.
      if (input.defaultRoleSlug !== undefined) {
        if (input.defaultRoleSlug === null) {
          patch.defaultRoleId = null;
        } else {
          const role = await tx.query.roles.findFirst({
            where: (r, { eq: eq2, and: and2 }) =>
              and2(eq2(r.orgId, orgId), eq2(r.slug, input.defaultRoleSlug!)),
          });
          if (!role) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'admin.errors.roleNotFound',
            });
          }
          // Don't let an admin-tier role be the store default. By
          // contract a store default should be a per-store role; the
          // grantRole gate already refuses non-admin scope='global',
          // so an admin/super_admin default would just bork the
          // invite path.
          if (role.rank >= ADMIN_RANK) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'admin.errors.defaultRoleMustBeStoreTier',
            });
          }
          // ADM-5 (2026-10-30): the default is granted to anyone invited
          // here without a role, so it is a grant by the actor and takes
          // the same rank gate: a manager could set a role above their
          // own and have later invitees receive it.
          const actorStoreRank = await getActorMaxRankInStore(
            tx,
            orgId,
            ctx.session!.userId,
            input.storeId,
          );
          if (role.rank >= actorStoreRank) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.cannotGrantEqualOrHigher',
            });
          }
          // D8: nor one carrying keys the actor lacks at this store.
          await assertCanPassOnRole(tx, ctx, role.id, input.storeId);
          patch.defaultRoleId = role.id;
        }
      }
      await withUniqueKey(
        tx.update(s.stores).set(patch).where(eq(s.stores.id, input.storeId)),
        'admin.errors.codeTaken',
      );
      // ADM2-06 (2026-11-09): from what to what, not only the new values.
      const changes = auditChanges(existing, patch, [
        'name',
        'code',
        'address',
        'timezone',
        'isActive',
      ]);
      if (patch.defaultRoleId !== undefined && patch.defaultRoleId !== existing.defaultRoleId) {
        changes.defaultRole = [
          await roleNameForAudit(tx, existing.defaultRoleId),
          await roleNameForAudit(tx, patch.defaultRoleId),
        ];
      }
      await auditAdmin(tx, ctx, 'admin.store.update', 'store', input.storeId, {
        ...input,
        changes,
      });
      broadcastCatalog(orgId, 'store');
      return { ok: true };
    });
  }),

  /** ADM-18 (2026-10-30): what archiving would leave hanging, for the
   *  confirmation: open orders and runs still under way at the store. */
  storeArchiveImpact: authedProcedure
    .input(StoreDeleteInputSchema)
    .query(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const [orders] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.orderSessionsV)
          .where(
            and(
              eq(s.orderSessionsV.orgId, orgId),
              eq(s.orderSessionsV.storeId, input.storeId),
              inArray(s.orderSessionsV.status, ['draft', 'submitted', 'approved']),
            ),
          );
        const [runs] = await tx
          .select({ n: sql<number>`count(distinct ${s.orderSessionsV.runId})::int` })
          .from(s.orderSessionsV)
          .innerJoin(s.marketRunsV, eq(s.marketRunsV.id, s.orderSessionsV.runId))
          .where(
            and(
              eq(s.orderSessionsV.orgId, orgId),
              eq(s.orderSessionsV.storeId, input.storeId),
              inArray(s.marketRunsV.status, ['planned', 'purchasing', 'delivering', 'amending']),
            ),
          );
        return { openOrders: orders?.n ?? 0, activeRuns: runs?.n ?? 0 };
      });
    }),

  storeDelete: authedProcedure.input(StoreDeleteInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: deleting a store cascades through every store-scoped row
    // for that location. Org.admin only.
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await orgRowOr404(
        tx,
        s.stores,
        orgId,
        input.storeId,
        'admin.errors.storeNotFound',
      );
      // ADM-18 (2026-10-30): archiving it again rewrote the date and the audit.
      if (existing.deletedAt) return { ok: true };
      // Soft delete via deleted_at timestamp + isActive=false. Hard delete
      // would cascade through every order_session, run_item_store, etc.
      // — much too destructive for a button tap.
      await tx
        .update(s.stores)
        .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(s.stores.id, input.storeId));
      await auditAdmin(tx, ctx, 'admin.store.delete', 'store', input.storeId, input);
      broadcastCatalog(orgId, 'store');
      return { ok: true };
    });
  }),

  /**
   * D4 (2026-05-06): clone a store's role bindings into another store.
   *
   * "I just opened Store C — give it the same team shape as Store A"
   * is a recurring request from chains opening new locations. Doing
   * it manually means: list store A's people → for each, grant the
   * same role in store C. Tedious and error-prone.
   *
   * What the clone does (review ADM2-31, 2026-11-12: this said the
   * bindings were always copied, and `includeMembers` only added the
   * store assignments):
   *   - The source's default role for newcomers becomes the target's,
   *     when the actor could grant it there (D7 / RE-ADM-2). Roles are
   *     org-wide, so that default is the store's role "shape". Without
   *     `includeMembers` this is all that is copied.
   *   - With `includeMembers`, the source's active members come along:
   *     each live store-scoped role binding in `sourceStoreId` gets an
   *     equivalent binding in `targetStoreId` (same member, role and
   *     expiry), and each assignment to the source store is copied to
   *     the target. Existing ones are skipped (idempotent re-runs). Off
   *     by default — most chain expansion wants the SHAPE replicated,
   *     staffed by different people.
   *   - Per-binding rank gate: skip (don't fail the whole op) any
   *     binding whose role outranks the actor's rank in the target.
   *     Counted separately and returned so the operator knows.
   *
   * Atomic in one transaction — partial success of "10 cloned, 2
   * skipped (rank), 0 failed" is fine; a transient PG error rolls
   * everything back.
   */
  storeCloneRoles: authedProcedure
    .input(StoreCloneRolesInputSchema)
    .mutation(async ({ ctx, input }) => {
      // M3.3: cloning role bindings across stores spans both source
      // AND target store authority; safer to gate on org.admin.
      requireOrgAdmin(ctx.session!.permissions);
      if (input.sourceStoreId === input.targetStoreId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.transferSameStore',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const sourceStore = await orgRowOr404(
          tx,
          s.stores,
          orgId,
          input.sourceStoreId,
          'admin.errors.storeNotFound',
        );
        const targetStore = await orgRowOr404(
          tx,
          s.stores,
          orgId,
          input.targetStoreId,
          'admin.errors.storeNotFound',
        );
        // C2: actor must administer BOTH ends. Reading the source's
        // shape AND writing into the target both qualify as admin
        // actions.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        const outside = [input.sourceStoreId, input.targetStoreId].filter(
          (id) => !allowed.includes(id),
        );
        // ADM2-31: a paused or archived store is outside every admin's
        // list; say that (ADM-16) rather than "not this store's admin",
        // which an org admin got for a paused store.
        if (outside.length > 0) throw await notAdminOfStore(tx, orgId, outside);
        const targetActorRank = await getActorMaxRankInStore(
          tx,
          orgId,
          ctx.session!.userId,
          input.targetStoreId,
        );
        // D7 / RE-ADM-2 (2026-10-31): roles themselves (name, rank,
        // permissions) are org-wide, so the store's role structure is its
        // default role for newcomers. Without "also members" that is all
        // that is copied; the source's people were bound to the target
        // regardless, against what the sheet promised.
        let defaultRoleCopied = false;
        if (sourceStore.defaultRoleId && sourceStore.defaultRoleId !== targetStore.defaultRoleId) {
          const role = await tx.query.roles.findFirst({
            where: (r, { eq: eq2, and: and2 }) =>
              and2(eq2(r.id, sourceStore.defaultRoleId!), eq2(r.orgId, orgId)),
          });
          if (
            role &&
            role.rank < ADMIN_RANK &&
            role.rank < targetActorRank &&
            !(await missingRoleKey(tx, ctx, role.id, input.targetStoreId))
          ) {
            await tx
              .update(s.stores)
              .set({ defaultRoleId: role.id, updatedAt: new Date() })
              .where(eq(s.stores.id, input.targetStoreId));
            defaultRoleCopied = true;
          }
        }
        let cloned = 0;
        let skippedRank = 0;
        let skippedExisting = 0;
        let skippedPermission = 0;
        let assigned = 0;
        if (input.includeMembers) {
          // Pull source bindings (only store-scoped + active members).
          // ADM1-04: live ones, each copied with its expiry.
          const sourceBindings = await tx
            .select({
              memberId: s.memberRoleBindings.memberId,
              userId: s.members.userId,
              roleId: s.memberRoleBindings.roleId,
              roleSlug: s.roles.slug,
              roleRank: s.roles.rank,
              expiresAt: s.memberRoleBindings.expiresAt,
            })
            .from(s.memberRoleBindings)
            .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
            .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
            .where(
              and(
                eq(s.memberRoleBindings.scopeType, 'store'),
                eq(s.memberRoleBindings.scopeId, input.sourceStoreId),
                eq(s.members.status, 'active'),
                bindingIsLive(),
              ),
            );
          // D8: a role whose keys the actor lacks in the target is skipped
          // like one above their rank.
          const missingByRole = new Map<string, string | null>();
          // ADM1-08: so is a role for the actor themself, or for someone
          // who already stands as high as the actor in the target.
          const refusedByMember = new Map<string, boolean>();
          const scope = { type: 'store', storeId: input.targetStoreId } as const;
          for (const b of sourceBindings) {
            if (b.roleRank >= targetActorRank) {
              skippedRank++;
              continue;
            }
            if (!refusedByMember.has(b.memberId)) {
              refusedByMember.set(
                b.memberId,
                !!(await recipientRefusal(ctx.db, tx, granterOf(ctx), b.userId, scope)),
              );
            }
            if (refusedByMember.get(b.memberId)) {
              skippedRank++;
              continue;
            }
            if (!missingByRole.has(b.roleId)) {
              missingByRole.set(
                b.roleId,
                await missingRoleKey(tx, ctx, b.roleId, input.targetStoreId),
              );
            }
            if (missingByRole.get(b.roleId)) {
              skippedPermission++;
              continue;
            }
            const { outcome, bindingId } = await grantBinding(tx, {
              memberId: b.memberId,
              roleId: b.roleId,
              scope,
              grantedBy: ctx.session!.userId,
              expiresAt: b.expiresAt,
            });
            if (outcome === 'held') {
              skippedExisting++;
              continue;
            }
            cloned++;
            // ADM2-07 (2026-11-09): each copied binding is a grant, and is
            // audited as one (who got which role where), as grantRole does;
            // the summary row below only counted them.
            await auditAdmin(tx, ctx, 'admin.role.grant', 'member', b.memberId, {
              roleSlug: b.roleSlug,
              scopeType: 'store',
              scopeId: input.targetStoreId,
              bindingId,
              roleRank: b.roleRank,
              via: 'storeCloneRoles',
              sourceStoreId: input.sourceStoreId,
            });
          }
          // Also populate the target's store assignments from the source's.
          // ADM2-31: active members only, as with the bindings above; an
          // invited or suspended member was assigned to the new store too.
          const sourceMsa = await tx
            .select({ memberId: s.memberStoreAssignments.memberId })
            .from(s.memberStoreAssignments)
            .innerJoin(s.members, eq(s.members.id, s.memberStoreAssignments.memberId))
            .where(
              and(
                eq(s.memberStoreAssignments.storeId, input.sourceStoreId),
                eq(s.members.status, 'active'),
              ),
            );
          for (const r of sourceMsa) {
            const inserted = await tx
              .insert(s.memberStoreAssignments)
              .values({
                memberId: r.memberId,
                storeId: input.targetStoreId,
                assignedBy: ctx.session!.userId,
              })
              .onConflictDoNothing()
              .returning({ memberId: s.memberStoreAssignments.memberId });
            if (inserted.length === 0) continue;
            assigned++;
            await auditAdmin(tx, ctx, 'admin.memberAssignStore', 'member', r.memberId, {
              memberId: r.memberId,
              storeId: input.targetStoreId,
              via: 'storeCloneRoles',
            });
          }
        }
        await auditAdmin(tx, ctx, 'admin.store.cloneRoles', 'store', input.targetStoreId, {
          ...input,
          cloned,
          skippedRank,
          skippedExisting,
          skippedPermission,
          assigned,
          defaultRoleCopied,
        });
        broadcastPeople(orgId);
        if (defaultRoleCopied) broadcastCatalog(orgId, 'store');
        return {
          ok: true,
          cloned,
          skippedRank,
          skippedExisting,
          skippedPermission,
          assigned,
          defaultRoleCopied,
        };
      });
    }),
};
