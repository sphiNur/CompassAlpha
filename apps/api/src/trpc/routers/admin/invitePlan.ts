/**
 * What an invitation gives: the stores the person joins and the role
 * bindings they get there.
 *
 * Review ADM1-12 (2026-11-13): the invite link (memberInviteCreate) and the
 * invite by Telegram ID (memberInviteByTgId) each worked this out in a copy
 * of their own, and the copies drifted. The Telegram path checked the
 * stores again with a query that kept archived ones ("filter rather than
 * throw"), and neither said which rule was the real one. Both ask here now:
 * the link keeps the plan on the invite until it is opened, and the
 * Telegram path applies it at once.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import { ADMIN_RANK } from '@compass/contracts';
import { grantRefusal, type InviteGrant } from '../../../services/adminAuthority';
import type { RequestContext } from '../../context';
import { assertCanInviteIntoStore, assertCanInviteWithRole, granterOf } from './grants';
import { getActorAdminScope, notAdminOfStore, storesAdministeredBy } from './scope';

export interface InvitePlan {
  /** The stores the person joins, each once: open stores the actor administers. */
  storeIds: string[];
  /**
   * The role the actor picked, bound organisation-wide or in each store;
   * or, when they picked none, each store's default role where they may
   * hand it on.
   */
  grants: InviteGrant[];
  /**
   * Whether `grants` is the role the actor picked. A grant of it that is
   * not allowed is refused; a store's default role is skipped instead.
   */
  picked: boolean;
}

export async function planInvite(
  tx: DB,
  ctx: RequestContext,
  input: { roleSlug?: string | null; storeIds: readonly string[] },
): Promise<InvitePlan> {
  const orgId = ctx.session!.orgId;
  const storeIds = [...new Set(input.storeIds)];
  // SECURITY (2026-05-04): someone without an admin role needs a store, or
  // every store-scoped query comes back empty for them: active, but locked
  // out. Admins see every store through the admin bypass.
  const isAdminInvite = input.roleSlug === 'admin' || input.roleSlug === 'super_admin';
  if (!isAdminInvite && storeIds.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'admin.errors.inviteNeedsStore' });
  }

  // C2 (2026-05-06): only into stores the actor administers, and only open
  // ones (ADM1-16); an archived store gets its own refusal.
  const adminScope = await getActorAdminScope(tx, orgId, ctx.session!.userId);
  const allowedStores = new Set(await storesAdministeredBy(tx, orgId, adminScope));
  for (const storeId of storeIds) {
    if (!allowedStores.has(storeId)) throw await notAdminOfStore(tx, orgId, [storeId]);
  }
  // ADM1-03: an org-tier invite needs admin authority held organisation-
  // wide. "Administers every active store" stood in for it, which a store
  // manager of a one-store org passes and a global admin with one denied
  // store fails.
  if (isAdminInvite && !adminScope?.isGlobalAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'admin.errors.cannotInviteOrgAdminAsStoreAdmin',
    });
  }

  if (input.roleSlug) {
    const slug = input.roleSlug;
    const role = await tx.query.roles.findFirst({
      where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.orgId, orgId), eq2(r.slug, slug)),
    });
    if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
    // F8 / C1: an org-tier role is one global binding, and needs a global
    // org admin; any other role is a binding per store, and the actor must
    // be able to hand it on in every one of them (D8).
    if (await assertCanInviteWithRole(tx, ctx, role)) {
      return {
        storeIds,
        picked: true,
        grants: [{ roleId: role.id, rank: role.rank, scopeType: 'global', scopeId: null }],
      };
    }
    const grants: InviteGrant[] = [];
    for (const storeId of storeIds) {
      await assertCanInviteIntoStore(tx, ctx, role, storeId);
      grants.push({ roleId: role.id, rank: role.rank, scopeType: 'store', scopeId: storeId });
    }
    return { storeIds, picked: true, grants };
  }

  // D3 (2026-05-06): no role picked, so each store's default role, bound to
  // that store. A store without one adds none, an admin-tier default is
  // never handed out this way, and one the actor may not hand on there is
  // left out rather than refusing the whole invitation.
  const defaults =
    storeIds.length > 0
      ? await tx
          .select({ id: s.stores.id, defaultRoleId: s.stores.defaultRoleId })
          .from(s.stores)
          .where(and(eq(s.stores.orgId, orgId), inArray(s.stores.id, storeIds)))
      : [];
  const defaultRoleOf = new Map(defaults.map((st) => [st.id, st.defaultRoleId]));
  const grants: InviteGrant[] = [];
  for (const storeId of storeIds) {
    const roleId = defaultRoleOf.get(storeId);
    if (!roleId) continue;
    const role = await tx.query.roles.findFirst({ where: (r, { eq: eq2 }) => eq2(r.id, roleId) });
    if (!role || role.rank >= ADMIN_RANK) continue;
    if (await grantRefusal(ctx.db, tx, granterOf(ctx), role, { type: 'store', storeId })) continue;
    grants.push({ roleId: role.id, rank: role.rank, scopeType: 'store', scopeId: storeId });
  }
  return { storeIds, picked: false, grants };
}
