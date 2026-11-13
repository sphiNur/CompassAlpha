/**
 * The people a store's daily close can pay wages to: the settlement
 * editor's picker and the attendance screens read them (review CONF-09 /
 * COREAPI-10, 2026-11). This lived in the settlement router, and the
 * attendance router imported it from there: one router depending on another.
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import { bindingIsLive } from './liveGrants';

/** Deliberately omits rank/permissions: the picker needs only a role label. */
export type WageRosterRole = { id: string; slug: string; name: string };
type WageRosterRoleWithRank = WageRosterRole & { rank: number };
export type WageRosterMember = {
  memberId: string;
  displayName: string;
  roles: WageRosterRole[];
};

/**
 * Minimal, store-scoped wage roster. It intentionally avoids admin.memberList:
 * cashiers need this picker, while the admin directory exposes organization-
 * wide data and requires users.manage. A person belongs to a store through an
 * explicit assignment or an active store-scoped role binding; global roles by
 * themselves never make every employee a wage recipient in every store.
 */
export async function loadWageRoster(
  tx: DB,
  orgId: string,
  storeId: string,
): Promise<WageRosterMember[]> {
  const now = new Date();
  const activeMemberConditions = [
    eq(s.members.orgId, orgId),
    eq(s.members.status, 'active'),
    isNull(s.users.deletedAt),
  ] as const;
  const [assignmentRows, scopedRoleRows] = await Promise.all([
    tx
      .select({ memberId: s.memberStoreAssignments.memberId })
      .from(s.memberStoreAssignments)
      .innerJoin(s.members, eq(s.members.id, s.memberStoreAssignments.memberId))
      .innerJoin(s.users, eq(s.users.id, s.members.userId))
      .where(and(eq(s.memberStoreAssignments.storeId, storeId), ...activeMemberConditions)),
    tx
      .select({ memberId: s.memberRoleBindings.memberId })
      .from(s.memberRoleBindings)
      .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
      .innerJoin(s.users, eq(s.users.id, s.members.userId))
      .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
      .where(
        and(
          eq(s.memberRoleBindings.scopeType, 'store'),
          eq(s.memberRoleBindings.scopeId, storeId),
          eq(s.roles.orgId, orgId),
          bindingIsLive(now),
          ...activeMemberConditions,
        ),
      ),
  ]);
  const memberIds = [...new Set([...assignmentRows, ...scopedRoleRows].map((row) => row.memberId))];
  if (memberIds.length === 0) return [];

  const [people, roleRows] = await Promise.all([
    tx
      .select({ memberId: s.members.id, displayName: s.users.displayName })
      .from(s.members)
      .innerJoin(s.users, eq(s.users.id, s.members.userId))
      .where(and(inArray(s.members.id, memberIds), ...activeMemberConditions)),
    tx
      .select({
        memberId: s.memberRoleBindings.memberId,
        id: s.roles.id,
        slug: s.roles.slug,
        name: s.roles.name,
        rank: s.roles.rank,
      })
      .from(s.memberRoleBindings)
      .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
      .where(
        and(
          inArray(s.memberRoleBindings.memberId, memberIds),
          eq(s.roles.orgId, orgId),
          or(
            eq(s.memberRoleBindings.scopeType, 'global'),
            and(
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, storeId),
            ),
          ),
          bindingIsLive(now),
        ),
      ),
  ]);

  const rolesByMember = new Map<string, Map<string, WageRosterRoleWithRank>>();
  for (const row of roleRows) {
    const roles = rolesByMember.get(row.memberId) ?? new Map<string, WageRosterRoleWithRank>();
    roles.set(row.id, { id: row.id, slug: row.slug, name: row.name, rank: row.rank });
    rolesByMember.set(row.memberId, roles);
  }

  return people
    .map((person) => ({
      memberId: person.memberId,
      displayName: person.displayName,
      roles: [...(rolesByMember.get(person.memberId)?.values() ?? [])]
        .sort((left, right) => right.rank - left.rank || left.name.localeCompare(right.name))
        .map(({ id, slug, name }) => ({ id, slug, name })),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
