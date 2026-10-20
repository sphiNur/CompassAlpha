import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from './client';
import * as s from './schema';
import { BUILTIN_ROLES, PERMISSIONS } from './seed-data';

export const DEFAULT_ORG_WORKFLOW = {
  steps: ['draft', 'submitted', 'approved', 'in_run', 'delivered', 'confirmed'],
} as const;

export const DEFAULT_FEATURE_FLAGS = [
  { key: 'price_alert.threshold_multiplier', value: { value: 1.2 } },
  { key: 'price_alert.threshold_uzs', value: { value: 10000 } },
  { key: 'order.default_step_for_kg', value: { value: 0.5 } },
  { key: 'workflow.skip_approval', value: { value: false } },
] as const;

/**
 * Human-entered names are not guaranteed to contain Latin letters
 * (a Chinese restaurant name normalises to an empty string). Always
 * append a short random suffix so creation never depends on language
 * or on winning a slug race.
 */
export function organizationSlugFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}

export interface ProvisionOrganizationInput {
  name: string;
  slug: string;
  locale?: string;
  timezone?: string;
  ownerUserId?: string | null;
}

/**
 * Create an organisation that is immediately usable: permission
 * catalog, built-in role ladder, default product flags, and (when an
 * owner is supplied) an active membership with the org-admin role.
 *
 * The caller owns the transaction, because this usually runs before a
 * tenant is known and must therefore use an explicit system context.
 */
export async function provisionOrganization(
  tx: DB,
  input: ProvisionOrganizationInput,
): Promise<{ orgId: string; orgSlug: string; ownerMemberId: string | null }> {
  await tx
    .insert(s.permissions)
    .values(PERMISSIONS.map((p) => ({ key: p.key, description: p.description })))
    .onConflictDoNothing();

  const [org] = await tx
    .insert(s.organizations)
    .values({
      slug: input.slug,
      name: input.name,
      localeDefault: input.locale ?? 'en',
      timezone: input.timezone ?? 'Asia/Tashkent',
      workflow: DEFAULT_ORG_WORKFLOW,
    })
    .returning();
  if (!org) throw new Error('organization insert returned no row');

  let adminRoleId: string | null = null;
  for (const role of BUILTIN_ROLES) {
    const [row] = await tx
      .insert(s.roles)
      .values({
        orgId: org.id,
        slug: role.slug,
        name: role.name,
        description: role.description,
        isBuiltIn: true,
        rank: role.rank,
      })
      .returning();
    if (!row) continue;
    if (role.slug === 'admin') adminRoleId = row.id;
    if (role.permissions.length > 0) {
      await tx
        .insert(s.rolePermissions)
        .values(role.permissions.map((key) => ({ roleId: row.id, permissionKey: key })))
        .onConflictDoNothing();
    }
  }

  await tx
    .insert(s.featureFlags)
    .values(DEFAULT_FEATURE_FLAGS.map((flag) => ({ orgId: org.id, ...flag })))
    .onConflictDoNothing();

  let ownerMemberId: string | null = null;
  if (input.ownerUserId) {
    if (!adminRoleId) throw new Error('built-in admin role was not provisioned');
    const [member] = await tx
      .insert(s.members)
      .values({
        orgId: org.id,
        userId: input.ownerUserId,
        status: 'active',
        invitedBy: input.ownerUserId,
      })
      .returning();
    if (!member) throw new Error('owner membership insert returned no row');
    ownerMemberId = member.id;
    await tx.insert(s.memberRoleBindings).values({
      memberId: member.id,
      roleId: adminRoleId,
      scopeType: 'global',
      scopeId: null,
      grantedBy: input.ownerUserId,
    });
  }

  // Keep the caller's "last org" pointer consistent in the same
  // transaction that makes them a member.
  if (input.ownerUserId) {
    await tx
      .update(s.users)
      .set({ lastOrgId: org.id, updatedAt: new Date() })
      .where(eq(s.users.id, input.ownerUserId));
  }

  return { orgId: org.id, orgSlug: org.slug, ownerMemberId };
}

/** Whether a slug is already taken. System context is the caller's job. */
export async function organizationSlugExists(tx: DB, slug: string): Promise<boolean> {
  const row = await tx.query.organizations.findFirst({
    where: (o, { eq: eq2 }) => eq2(o.slug, slug),
    columns: { id: true },
  });
  return !!row;
}
