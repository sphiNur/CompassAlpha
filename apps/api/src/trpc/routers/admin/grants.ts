/**
 * Whether the caller may hand on a role or a permission key. The rules
 * are in services/adminAuthority; these apply them to the signed-in
 * admin and turn a refusal into the error the screen shows.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import { ADMIN_RANK } from '@compass/contracts';
import {
  effectiveGlobalPermissions,
  effectivePermissionsForStores,
} from '../../../services/storeScope';
import {
  grantRefusal,
  missingRoleKey as missingRoleKeyOf,
  passesOnAnyKey,
  recipientRefusal,
  roleTier,
  type Granter,
  type GrantRefusal,
  type GrantScope,
  type RecipientRefusal,
} from '../../../services/adminAuthority';
import { requireOrgAdmin } from './guards';
import { getActorAdminStoreIds } from './scope';
import type { RequestContext } from '../../context';

/** The signed-in actor, as the grant rules in services/adminAuthority take them. */
export function granterOf(ctx: RequestContext): Granter {
  return {
    orgId: ctx.session!.orgId,
    memberId: ctx.session!.memberId,
    userId: ctx.session!.userId,
  };
}

/**
 * D8 / RE-ADM-10 (2026-10-31): the workspace's super admin and platform
 * administrators may pass on keys they do not hold themselves; everyone
 * else only what they have (passesOnAnyKey).
 */
export function exemptFromKeyCheck(tx: DB, ctx: RequestContext): Promise<boolean> {
  return passesOnAnyKey(ctx.db, tx, granterOf(ctx));
}

/** D8 for the signed-in actor: the first key of the role they lack there, or null. */
export function missingRoleKey(
  tx: DB,
  ctx: RequestContext,
  roleId: string,
  storeId: string | null,
): Promise<string | null> {
  return missingRoleKeyOf(ctx.db, tx, granterOf(ctx), roleId, storeId);
}

function throwRefusal(refusal: GrantRefusal | RecipientRefusal | null): void {
  if (!refusal) return;
  throw new TRPCError({
    code: refusal.code,
    message: refusal.message,
    ...('missingPermission' in refusal && refusal.missingPermission
      ? { cause: { missingPermission: refusal.missingPermission } }
      : {}),
  });
}

/**
 * ADM1-08 for the signed-in actor: the person receives a role in `scope`
 * only if the actor outranks them there, and is not the actor
 * (recipientRefusal).
 */
export async function assertCanGrantTo(
  tx: DB,
  ctx: RequestContext,
  recipientUserId: string,
  scope: GrantScope,
): Promise<void> {
  throwRefusal(await recipientRefusal(ctx.db, tx, granterOf(ctx), recipientUserId, scope));
}

/**
 * Security scan F8 (2026-10-31): the invite paths inline their own grant,
 * and only asked for `users.manage` before creating a GLOBAL binding.
 * Mirror grantRole: an org-tier role (rank ≥ 80, always bound globally)
 * or any role carrying `org.admin` needs a global org admin, ranked by
 * their global bindings alone; `org.admin` is never handed out per store.
 * Returns whether the grant is a global one.
 */
export async function assertCanInviteWithRole(
  tx: DB,
  ctx: RequestContext,
  role: { id: string; rank: number },
): Promise<boolean> {
  const tier = await roleTier(tx, role);
  if (tier === 'invalid') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'admin.errors.orgAdminMustBeGlobal' });
  }
  if (tier === 'store') return false;
  requireOrgAdmin(ctx.session!.permissions);
  throwRefusal(await grantRefusal(ctx.db, tx, granterOf(ctx), role, { type: 'global' }));
  return true;
}

/**
 * The store half of an invite's grant (C1, D8): the actor outranks the
 * role in that store and holds its keys there. The same rule decides
 * again when the link is opened (inviterStillAuthorized).
 */
export async function assertCanInviteIntoStore(
  tx: DB,
  ctx: RequestContext,
  role: { id: string; rank: number },
  storeId: string,
): Promise<void> {
  throwRefusal(await grantRefusal(ctx.db, tx, granterOf(ctx), role, { type: 'store', storeId }));
}

/** Where the actor may pass a role or a key on: organisation-wide, and in which stores. */
export type PassOn = { global: boolean; storeIds: string[] };

/** For a role or key a lookup below did not cover: nowhere (fail closed). */
export const PASS_ON_NOWHERE: PassOn = { global: false, storeIds: [] };

/**
 * DX-ADM-1 (2026-11-01): where the actor may hand each role on as far as
 * its keys go (D8, `missingRoleKey`): globally, and in which of the stores
 * they administer. The grant, default-role and invite screens used to list
 * every role below the actor's rank and only learnt from a 403 that a
 * custom role carried a key the actor lacks. The rank rule stays on the
 * client (lib/authority canGrantRole).
 */
export async function rolePassOnScopes(
  tx: DB,
  ctx: RequestContext,
  roles: readonly { id: string; isBuiltIn: boolean }[],
): Promise<Map<string, PassOn>> {
  const session = ctx.session!;
  // Paused stores too: their default role can still be set (storeUpdate).
  const storeIds = await getActorAdminStoreIds(tx, session.orgId, session.userId, {
    includeInactive: true,
  });
  const out = new Map<string, PassOn>();
  const everywhere = () => ({ global: true, storeIds: [...storeIds] });
  const custom = roles.filter((r) => !r.isBuiltIn);
  const exempt = custom.length === 0 || (await exemptFromKeyCheck(tx, ctx));
  const keysByRole = new Map<string, string[]>();
  if (!exempt) {
    const rows = await tx
      .select({ roleId: s.rolePermissions.roleId, key: s.rolePermissions.permissionKey })
      .from(s.rolePermissions)
      .where(
        inArray(
          s.rolePermissions.roleId,
          custom.map((r) => r.id),
        ),
      );
    for (const row of rows) {
      keysByRole.set(row.roleId, [...(keysByRole.get(row.roleId) ?? []), row.key]);
    }
  }
  const needsCheck = [...keysByRole.keys()];
  if (needsCheck.length === 0) {
    for (const r of roles) out.set(r.id, everywhere());
    return out;
  }
  const { global, perStore } = await actorKeySets(tx, ctx, storeIds);
  for (const r of roles) {
    const keys = keysByRole.get(r.id);
    if (!keys) {
      out.set(r.id, everywhere());
      continue;
    }
    out.set(r.id, {
      global: keys.every((k) => global.has(k)),
      storeIds: perStore.filter(([, held]) => keys.every((k) => held.has(k))).map(([id]) => id),
    });
  }
  return out;
}

/**
 * Where the signed-in actor holds each key, so may pass it on (ADM1-07):
 * into a role (roleCreate / roleUpdate add only keys held organisation-
 * wide) or as an `allow` override (memberPermissionSet: held in that
 * scope). The super admin and platform admins pass on any key. The key
 * pickers used to list every key and learn from a 403 which ones the
 * actor lacked. The rank and scope rules stay on the client
 * (lib/authority overrideEffects).
 */
export async function keyPassOnScopes(
  tx: DB,
  ctx: RequestContext,
  keys: readonly string[],
): Promise<Map<string, PassOn>> {
  const session = ctx.session!;
  const storeIds = await getActorAdminStoreIds(tx, session.orgId, session.userId, {
    includeInactive: true,
  });
  if (await exemptFromKeyCheck(tx, ctx)) {
    return new Map(keys.map((key) => [key, { global: true, storeIds: [...storeIds] }]));
  }
  const { global, perStore } = await actorKeySets(tx, ctx, storeIds);
  return new Map(
    keys.map((key) => [
      key,
      {
        global: global.has(key),
        storeIds: perStore.filter(([, held]) => held.has(key)).map(([id]) => id),
      },
    ]),
  );
}

/** The keys the signed-in actor holds organisation-wide, and in each of `storeIds`. */
async function actorKeySets(
  tx: DB,
  ctx: RequestContext,
  storeIds: readonly string[],
): Promise<{
  global: ReadonlySet<string>;
  perStore: ReadonlyArray<readonly [string, ReadonlySet<string>]>;
}> {
  const session = ctx.session!;
  const global = await effectiveGlobalPermissions(tx, session.memberId);
  // Review RUNAPI-12 (2026-11-12): every store in one lookup, not two
  // queries for each store the admin manages.
  const byStore = await effectivePermissionsForStores(tx, session.memberId, storeIds);
  const perStore = storeIds.map((id) => [id, byStore.get(id) ?? new Set<string>()] as const);
  return { global, perStore };
}

export async function assertCanPassOnRole(
  tx: DB,
  ctx: RequestContext,
  roleId: string,
  storeId: string | null,
): Promise<void> {
  const missing = await missingRoleKey(tx, ctx, roleId, storeId);
  if (missing) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.cannotGrantMissingPermission',
      cause: { missingPermission: missing },
    });
  }
}

/** Ids of the org's roles at admin rank or above (ADM-14). */
export async function adminRankRoleIds(tx: DB, orgId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ id: s.roles.id })
    .from(s.roles)
    .where(and(eq(s.roles.orgId, orgId), gte(s.roles.rank, ADMIN_RANK)));
  return new Set(rows.map((r) => r.id));
}
