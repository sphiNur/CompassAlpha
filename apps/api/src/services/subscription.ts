import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled';

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

function computeWriteAccess(
  status: string,
  trialEndsAt: Date | null,
  periodEnd: Date | null,
  graceEndsAt: Date | null,
): boolean {
  if (status === 'suspended' || status === 'canceled') return false;
  const now = Date.now();
  if (graceEndsAt && graceEndsAt.getTime() > now) return true;
  if (status === 'trialing') {
    return !trialEndsAt || trialEndsAt.getTime() > now;
  }
  if (status === 'active') {
    return !periodEnd || periodEnd.getTime() > now;
  }
  return false;
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

  const usage = { stores: storeCount?.n ?? 0, members: memberCount?.n ?? 0 };
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

export function assertWriteAccess(state: SubscriptionState): void {
  if (!state.writeAccess) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'subscription.errors.readOnly',
    });
  }
}

export async function assertCanAddStore(db: DB, orgId: string): Promise<void> {
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
  const state = await readSubscriptionState(db, orgId);
  assertWriteAccess(state);
  if (state.limits.members != null && state.usage.members >= state.limits.members) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'subscription.errors.memberLimit',
    });
  }
}
