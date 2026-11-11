/**
 * The organisation of a store-scope suite (admin-scope, store-scope-reads
 * and run-history-scope; review TEST2-04, TEST2-08, 2026-11). Each file
 * that calls `scopeOrgSuite` gets its own, made as sign-up makes one, so
 * the roles and their keys are the built-in ones. Tests add their own
 * stores and members. Nothing is cleaned up afterwards: the slug is
 * unique, and a failed run can be inspected.
 */
import { beforeAll } from 'bun:test';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../../trpc/router';
import type { RequestContext, SessionContext } from '../../trpc/context';
import { cleanUpAfterAll } from './cleanup';
import { testContext } from './ctx';
import { seedMember, seedOwnedOrg, seedUser, sessionOf } from './fixtures';
import { SHOULD_RUN } from './pg';

export interface ScopeOrg {
  orgId: string;
  /** The owner, who holds Super Admin org-wide. */
  superAdminUserId: string;
  superAdminMemberId: string;
  superAdminCtx: RequestContext;
  // The built-in roles, as every organisation gets them.
  superAdminRoleId: string;
  adminRoleId: string;
  managerRoleId: string;
  purchaserRoleId: string;
  staffRoleId: string;
}

export type BindingScope = { type: 'global' } | { type: 'store'; storeId: string };

/** Registers the file's `beforeAll` that makes the organisation `name`. */
export function scopeOrgSuite(name: string) {
  let org: ScopeOrg | null = null;
  const maintenance = () => getDb(undefined, { system: 'maintenance' });
  // The organisation and every user seeded here go after the file.
  cleanUpAfterAll();

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    const made = await seedOwnedOrg(maintenance(), name);
    const roleId = (slug: string): string => {
      const id = made.roleIds[slug];
      if (!id) throw new Error(`no built-in role "${slug}"`);
      return id;
    };
    org = {
      orgId: made.orgId,
      superAdminUserId: made.owner.userId,
      superAdminMemberId: made.owner.memberId,
      superAdminCtx: testContext(made.session),
      superAdminRoleId: roleId('super_admin'),
      adminRoleId: roleId('admin'),
      managerRoleId: roleId('manager'),
      purchaserRoleId: roleId('purchaser'),
      staffRoleId: roleId('staff'),
    };
  });

  /** The organisation, once `beforeAll` has made it. */
  function fixture(): ScopeOrg {
    if (!org) throw new Error('fixture missing');
    return org;
  }

  /** A store, made by the owner. */
  async function makeStore(storeName: string): Promise<{ id: string; name: string }> {
    const caller = appRouter.createCaller(fixture().superAdminCtx);
    const { id } = await caller.admin.storeCreate({ name: storeName });
    return { id, name: storeName };
  }

  async function makeUser(displayName: string): Promise<{ id: string; tgUserId: bigint }> {
    return seedUser(maintenance(), displayName);
  }

  /** `userId`'s membership of the organisation, with no roles yet. */
  async function makeMember(userId: string): Promise<string> {
    return (await seedMember(maintenance(), fixture().orgId, { userId })).memberId;
  }

  async function bindRole(memberId: string, roleId: string, scope: BindingScope): Promise<void> {
    await maintenance()
      .insert(s.memberRoleBindings)
      .values({
        memberId,
        roleId,
        scopeType: scope.type,
        scopeId: scope.type === 'store' ? scope.storeId : null,
      });
  }

  async function sessionFor(memberId: string, userId: string): Promise<SessionContext> {
    return sessionOf(fixture().orgId, { memberId, userId });
  }

  /**
   * Another org-wide Super Admin, for a test that tries to act against
   * one (review TEST2-09). Should the gate break, this member is changed,
   * not the owner every other test acts as.
   */
  async function makeSuperAdmin(
    displayName: string,
  ): Promise<{ userId: string; memberId: string }> {
    const user = await makeUser(displayName);
    const memberId = await makeMember(user.id);
    await bindRole(memberId, fixture().superAdminRoleId, { type: 'global' });
    return { userId: user.id, memberId };
  }

  return { fixture, makeStore, makeUser, makeMember, bindRole, sessionFor, makeSuperAdmin };
}
