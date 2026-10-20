import { eq } from 'drizzle-orm';
import type { DB } from './client';
import * as s from './schema';

export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_GRACE_DAYS = 7;

export const DEFAULT_BILLING_PLANS = [
  {
    code: 'legacy',
    name: 'Legacy / Enterprise',
    description: 'Unlimited agreement created before subscription enforcement',
    limits: { stores: null, members: null },
    sortIndex: 999,
  },
  {
    code: 'starter',
    name: 'Starter',
    description: 'One store and a small team',
    limits: { stores: 1, members: 10 },
    sortIndex: 10,
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'Up to three stores',
    limits: { stores: 3, members: 30 },
    sortIndex: 20,
  },
  {
    code: 'pro',
    name: 'Professional',
    description: 'Expanded stores and team limits',
    limits: { stores: 10, members: 100 },
    sortIndex: 30,
  },
] as const;

export async function ensureBillingPlans(tx: DB): Promise<void> {
  await tx
    .insert(s.billingPlans)
    .values(
      DEFAULT_BILLING_PLANS.map((plan) => ({
        code: plan.code,
        name: plan.name,
        description: plan.description,
        limits: plan.limits,
        sortIndex: plan.sortIndex,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Create the subscription row for a newly provisioned tenant. Existing
 * tenants are backfilled by migration 0044.
 */
export async function provisionSubscription(
  tx: DB,
  orgId: string,
  options: {
    planCode?: string;
    status?: 'trialing' | 'active';
    trialDays?: number;
    createdBy?: string | null;
  } = {},
): Promise<void> {
  await ensureBillingPlans(tx);
  const now = new Date();
  const planCode = options.planCode ?? 'starter';
  const status = options.status ?? 'trialing';
  const trialDays = options.trialDays ?? DEFAULT_TRIAL_DAYS;
  const trialEndsAt =
    status === 'trialing' ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000) : null;
  const graceEndsAt =
    status === 'trialing'
      ? new Date((trialEndsAt ?? now).getTime() + DEFAULT_GRACE_DAYS * 24 * 60 * 60 * 1000)
      : null;

  await tx
    .insert(s.organizationSubscriptions)
    .values({
      orgId,
      planCode,
      status,
      trialEndsAt,
      graceEndsAt,
      updatedBy: options.createdBy ?? null,
      note: status === 'trialing' ? `Trial: ${trialDays} days` : null,
    })
    .onConflictDoNothing();
  await tx.update(s.organizations).set({ plan: planCode }).where(eq(s.organizations.id, orgId));
}
