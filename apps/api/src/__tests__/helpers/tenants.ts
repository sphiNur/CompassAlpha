/**
 * Tenants as sign-up makes them, on the starter trial with its limits,
 * all owned by one platform admin, so that a test can also change the
 * plan from the platform side (subscription and admin-audit-fixes).
 *
 * Each test makes a tenant of its own (review TEST2-09, NEW-RAND-01,
 * 2026-11). The tests change the plan and the status, and fill the
 * tenant to its limits. When they shared one, each depended on what the
 * one before had left.
 */
import { afterAll, beforeAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  getDb,
  organizationSlugFromName,
  provisionOrganization,
  schema as s,
  withSystemContext,
} from '@compass/db';
import type { SessionContext } from '../../trpc/context';
import { SHOULD_RUN } from './pg';
import { freshTgId } from './telegram';

export interface Tenant {
  orgId: string;
  /** The owner's session, as an org admin. */
  session: SessionContext;
}

/**
 * Call inside the suite's `describe`. It registers the `beforeAll` that
 * makes the platform admin and the `afterAll` that removes the tenants,
 * the admin and each user passed to `track`.
 */
export function tenantSuite(name: string) {
  let userId = '';
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const maintenance = () => getDb(undefined, { system: 'maintenance' });

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    const db = maintenance();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId: freshTgId(), displayName: `${name} owner`, displayNameLocked: true })
      .returning();
    userId = user!.id;
    await db.insert(s.platformAdmins).values({ userId, note: name });
  });

  afterAll(async () => {
    if (!userId) return;
    const db = maintenance();
    for (const id of orgIds) await db.delete(s.organizations).where(eq(s.organizations.id, id));
    for (const id of [userId, ...userIds]) await db.delete(s.users).where(eq(s.users.id, id));
  });

  async function newTenant(): Promise<Tenant> {
    const created = await withSystemContext(maintenance(), 'auth', (tx) =>
      provisionOrganization(tx, {
        name,
        slug: organizationSlugFromName(name),
        ownerUserId: userId,
      }),
    );
    orgIds.push(created.orgId);
    return {
      orgId: created.orgId,
      session: {
        userId,
        memberId: created.ownerMemberId!,
        orgId: created.orgId,
        writeAccess: true,
        orgTimezone: 'UTC',
        permissions: new Set(['users.manage', 'org.admin']),
        roleSlugs: new Set(['admin']),
      },
    };
  }

  /** A user to remove with the tenants, such as a member seeded into one. */
  function track(id: string): void {
    userIds.push(id);
  }

  return { newTenant, track };
}
