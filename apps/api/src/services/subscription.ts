import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SubscriptionStatus } from '@compass/contracts';
import { schema as s, type DB } from '@compass/db';

export interface SubscriptionLimits {
  stores: number | null;
  members: number | null;
}

export interface SubscriptionState {
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  writeAccess: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  limits: SubscriptionLimits;
  usage: { stores: number; members: number };
}

function normalizeLimits(value: unknown): SubscriptionLimits {
  const raw = (value ?? {}) as { stores?: unknown; members?: unknown };
  const normalize = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  return { stores: normalize(raw.stores), members: normalize(raw.members) };
}

/**
 * Whether the tenant may write. Each date counts up to, not including,
 * its own moment. Exported, with `now`, for the boundary tests.
 */
export function computeWriteAccess(
  status: string,
  trialEndsAt: Date | null,
  periodEnd: Date | null,
  graceEndsAt: Date | null,
  now: number = Date.now(),
): boolean {
  if (status === 'suspended' || status === 'canceled') return false;
  if (graceEndsAt && graceEndsAt.getTime() > now) return true;
  if (status === 'trialing') {
    return !trialEndsAt || trialEndsAt.getTime() > now;
  }
  if (status === 'active') {
    return !periodEnd || periodEnd.getTime() > now;
  }
  return false;
}

type SubscriptionRow = {
  subscription: typeof s.organizationSubscriptions.$inferSelect;
  plan: typeof s.billingPlans.$inferSelect;
};

/** One org's state from its subscription row, if it has one, and its usage. */
function subscriptionStateOf(
  row: SubscriptionRow | undefined,
  usage: SubscriptionState['usage'],
): SubscriptionState {
  if (!row) {
    // Defensive fallback for a pre-migration row; never lock out a
    // tenant because the subscription record is missing.
    return {
      planCode: 'legacy',
      planName: 'Legacy / Enterprise',
      status: 'active',
      writeAccess: true,
      trialEndsAt: null,
      currentPeriodEnd: null,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
      limits: { stores: null, members: null },
      usage,
    };
  }

  const sub = row.subscription;
  return {
    planCode: row.plan.code,
    planName: row.plan.name,
    status: sub.status as SubscriptionStatus,
    writeAccess: computeWriteAccess(
      sub.status,
      sub.trialEndsAt,
      sub.currentPeriodEnd,
      sub.graceEndsAt,
    ),
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    limits: normalizeLimits(row.plan.limits),
    usage,
  };
}

/**
 * Read the tenant's subscription and live usage. Call this inside the
 * org's RLS context for normal requests, or inside a system context for
 * the platform-admin console.
 */
export async function readSubscriptionState(db: DB, orgId: string): Promise<SubscriptionState> {
  const [row] = await db
    .select({
      subscription: s.organizationSubscriptions,
      plan: s.billingPlans,
    })
    .from(s.organizationSubscriptions)
    .innerJoin(s.billingPlans, eq(s.billingPlans.code, s.organizationSubscriptions.planCode))
    .where(eq(s.organizationSubscriptions.orgId, orgId))
    .limit(1);

  const [storeCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.stores)
    .where(and(eq(s.stores.orgId, orgId), eq(s.stores.isActive, true)));
  const [memberCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.members)
    .where(and(eq(s.members.orgId, orgId), eq(s.members.status, 'active')));

  return subscriptionStateOf(row, { stores: storeCount?.n ?? 0, members: memberCount?.n ?? 0 });
}

/**
 * readSubscriptionState for many orgs in three queries. The lookup it
 * returns gives each org passed the state readSubscriptionState would.
 *
 * Review NEW-PLATFORM-N1 (2026-11-12): the platform console's list ran
 * those three queries, and one more for the note, for every org.
 */
export async function readSubscriptionStates(
  db: DB,
  orgIds: readonly string[],
): Promise<(orgId: string) => SubscriptionState> {
  const ids = [...orgIds];
  const rows = await db
    .select({
      subscription: s.organizationSubscriptions,
      plan: s.billingPlans,
    })
    .from(s.organizationSubscriptions)
    .innerJoin(s.billingPlans, eq(s.billingPlans.code, s.organizationSubscriptions.planCode))
    .where(inArray(s.organizationSubscriptions.orgId, ids));
  const storeCounts = await db
    .select({ orgId: s.stores.orgId, n: sql<number>`count(*)::int` })
    .from(s.stores)
    .where(and(inArray(s.stores.orgId, ids), eq(s.stores.isActive, true)))
    .groupBy(s.stores.orgId);
  const memberCounts = await db
    .select({ orgId: s.members.orgId, n: sql<number>`count(*)::int` })
    .from(s.members)
    .where(and(inArray(s.members.orgId, ids), eq(s.members.status, 'active')))
    .groupBy(s.members.orgId);

  const rowByOrg = new Map(rows.map((row) => [row.subscription.orgId, row]));
  const stores = new Map(storeCounts.map((c) => [c.orgId, c.n]));
  const members = new Map(memberCounts.map((c) => [c.orgId, c.n]));
  return (orgId) =>
    subscriptionStateOf(rowByOrg.get(orgId), {
      stores: stores.get(orgId) ?? 0,
      members: members.get(orgId) ?? 0,
    });
}

export function assertWriteAccess(state: SubscriptionState): void {
  if (!state.writeAccess) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'subscription.errors.readOnly',
    });
  }
}

/**
 * 2026-10-21 audit CA-18: serialise limit checks per org. Every caller
 * counts and then inserts/activates inside one transaction; without a
 * lock two concurrent invites (or a restore racing an invite) both read
 * "one seat left" and both commit. The xact lock is released with the
 * caller's transaction, so the count and the write it guards are atomic.
 * The key is distinct from the bare-orgId lock memberSetStatus uses for
 * the last-admin guard.
 */
export async function lockOrgLimits(db: DB, orgId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId} || ':limits'))`);
}

export async function assertCanAddStore(db: DB, orgId: string): Promise<void> {
  await lockOrgLimits(db, orgId);
  const state = await readSubscriptionState(db, orgId);
  assertWriteAccess(state);
  if (state.limits.stores != null && state.usage.stores >= state.limits.stores) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'subscription.errors.storeLimit',
    });
  }
}

export async function assertCanAddMember(db: DB, orgId: string): Promise<void> {
  await lockOrgLimits(db, orgId);
  const state = await readSubscriptionState(db, orgId);
  assertWriteAccess(state);
  if (state.limits.members != null && state.usage.members >= state.limits.members) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'subscription.errors.memberLimit',
    });
  }
}
