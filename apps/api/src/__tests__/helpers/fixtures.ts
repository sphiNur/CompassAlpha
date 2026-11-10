/**
 * Organisation fixtures for the PG-gated API tests (review TEST1-03,
 * 2026-11). Written with the maintenance handle, as fixtures are; the
 * code under test runs on the server's handle (helpers/ctx.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { BUILTIN_ROLES, PERMISSIONS } from '@compass/db/seed-data';
import { loadSession, type SessionContext } from '../../trpc/context';
import { freshTgId } from './telegram';

type Db = ReturnType<typeof getDb>;

/**
 * The built-in roles named by `slugs`, in `orgId`, each with its
 * permission keys. Returns their ids by slug.
 */
export async function seedRoles(
  db: Db,
  orgId: string,
  slugs: readonly string[],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const slug of slugs) {
    const def = BUILTIN_ROLES.find((r) => r.slug === slug);
    if (!def) throw new Error(`no built-in role "${slug}"`);
    const [role] = await db
      .insert(s.roles)
      .values({ orgId, slug, name: def.name, rank: def.rank, isBuiltIn: true })
      .returning();
    if (!role) throw new Error(`role "${slug}" was not inserted`);
    ids[slug] = role.id;
    const keys: readonly string[] = def.permissions;
    if (keys.length === 0) continue;
    await db
      .insert(s.permissions)
      .values(PERMISSIONS.filter((p) => keys.includes(p.key)))
      .onConflictDoNothing();
    await db
      .insert(s.rolePermissions)
      .values(keys.map((permissionKey) => ({ roleId: role.id, permissionKey })))
      .onConflictDoNothing();
  }
  return ids;
}

export interface MemberSpec {
  /** The user's display name. */
  name: string;
  status?: 'active' | 'suspended';
  /** Stores the member works in. */
  stores?: readonly string[];
  /** Role bindings: a store binding where `storeId` is set, a global one otherwise. */
  roles?: ReadonlyArray<{ roleId: string; storeId?: string | null }>;
}

export interface SeededMember {
  userId: string;
  memberId: string;
  /** The bindings of `roles`, in order. */
  bindingIds: string[];
}

/** A new user and their membership of `orgId`, assigned and bound as `spec` says. */
export async function seedMember(db: Db, orgId: string, spec: MemberSpec): Promise<SeededMember> {
  const [user] = await db
    .insert(s.users)
    .values({ displayName: spec.name, tgUserId: freshTgId() })
    .returning();
  if (!user) throw new Error('user was not inserted');
  const [member] = await db
    .insert(s.members)
    .values({ orgId, userId: user.id, status: spec.status ?? 'active' })
    .returning();
  if (!member) throw new Error('member was not inserted');
  for (const storeId of new Set(spec.stores ?? [])) {
    await db
      .insert(s.memberStoreAssignments)
      .values({ memberId: member.id, storeId, assignedBy: user.id });
  }
  const bindingIds: string[] = [];
  for (const role of spec.roles ?? []) {
    const [binding] = await db
      .insert(s.memberRoleBindings)
      .values({
        memberId: member.id,
        roleId: role.roleId,
        scopeType: role.storeId ? 'store' : 'global',
        scopeId: role.storeId ?? null,
      })
      .returning();
    if (!binding) throw new Error('role binding was not inserted');
    bindingIds.push(binding.id);
  }
  return { userId: user.id, memberId: member.id, bindingIds };
}

/** The session the server loads for `member` when it signs in, on the server's handle. */
export async function sessionOf(
  orgId: string,
  member: { userId: string; memberId: string },
): Promise<SessionContext> {
  const session = await loadSession(getDb(), member.userId, orgId, member.memberId);
  if (!session) throw new Error('session failed to load');
  return session;
}

export interface PurchaseSpec {
  runDate: string;
  /** The price of one unit, paid in cash. */
  unitPrice: string;
  /** How much of the purchase each store received. */
  splits: ReadonlyArray<{ storeId: string; qty: string }>;
}

/**
 * A finished run that bought one new product for the stores in `splits`,
 * written straight into the read model, which is all the finance reports
 * read. For tests of whose purchases a person may see.
 */
export async function seedFinishedPurchase(
  db: Db,
  orgId: string,
  spec: PurchaseSpec,
): Promise<{ runId: string; skuId: string }> {
  const code = `BUY-${randomUUID().slice(0, 8)}`;
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code, names: { en: code }, unit: 'kg', step: '1' })
    .returning();
  if (!sku) throw new Error('sku was not inserted');
  const runId = randomUUID();
  const qty = String(spec.splits.reduce((sum, split) => sum + Number(split.qty), 0));
  // A day's runs are numbered; take the next number on that day.
  const [day] = await db
    .select({ next: sql<number>`COALESCE(MAX(${s.marketRunsV.runIndex}) + 1, 0)::int` })
    .from(s.marketRunsV)
    .where(and(eq(s.marketRunsV.orgId, orgId), eq(s.marketRunsV.runDate, spec.runDate)));
  await db.insert(s.marketRunsV).values({
    id: runId,
    orgId,
    runDate: spec.runDate,
    runIndex: day?.next ?? 0,
    status: 'finished',
  });
  await db.insert(s.runItemsV).values({
    runId,
    skuId: sku.id,
    plannedQty: qty,
    purchasedQty: qty,
    unitPrice: spec.unitPrice,
    status: 'purchased',
    paymentMethod: 'cash',
  });
  await db
    .insert(s.runItemStoresV)
    .values(spec.splits.map((split) => ({ runId, skuId: sku.id, ...split })));
  return { runId, skuId: sku.id };
}
