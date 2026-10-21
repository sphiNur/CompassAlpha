import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, withSystemContext } from '@compass/db';
import { UuidSchema } from '@compass/contracts';
import { authedProcedure, router } from '../trpc';
import { isPlatformAdmin } from '../../services/platformAdmin';
import { readSubscriptionState } from '../../services/subscription';

const SubscriptionUpdateInputSchema = z.object({
  orgId: UuidSchema,
  planCode: z.string().min(1).max(32),
  status: z.enum(['trialing', 'active', 'past_due', 'suspended', 'canceled']),
  trialEndsAt: z.string().nullable().optional(),
  currentPeriodStart: z.string().nullable().optional(),
  currentPeriodEnd: z.string().nullable().optional(),
  graceEndsAt: z.string().nullable().optional(),
  // 2026-10-21 audit CA-39: optional (not default(false)) so an omitted
  // flag keeps the stored value instead of silently clearing it.
  cancelAtPeriodEnd: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'platform.errors.invalidDate' });
  }
  return date;
}

/**
 * 2026-10-21 audit CA-39 (A-13): `undefined` means "leave as is", `null`
 * (or an empty string) means "clear". Returns undefined for omitted
 * fields so the upsert's SET clause can skip them.
 */
function parseOptionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return parseDate(value);
}

async function requirePlatformAdmin(db: Parameters<typeof isPlatformAdmin>[0], userId: string) {
  if (!(await isPlatformAdmin(db, userId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.platformAdminRequired',
    });
  }
}

export const platformRouter = router({
  plans: authedProcedure.query(async ({ ctx }) => {
    await requirePlatformAdmin(ctx.db, ctx.session!.userId);
    return withSystemContext(ctx.db, 'auth', (tx) =>
      tx.query.billingPlans.findMany({
        where: (p, { eq: eq2 }) => eq2(p.isActive, true),
        orderBy: (p, { asc }) => asc(p.sortIndex),
      }),
    );
  }),

  organizations: authedProcedure.query(async ({ ctx }) => {
    await requirePlatformAdmin(ctx.db, ctx.session!.userId);
    return withSystemContext(ctx.db, 'auth', async (tx) => {
      const orgs = await tx.query.organizations.findMany({
        where: (o, { isNull }) => isNull(o.deletedAt),
        orderBy: (o, { asc }) => asc(o.createdAt),
      });
      return Promise.all(
        orgs.map(async (org) => {
          // 2026-10-21 audit CA-39 (A-13): the platform-internal note is
          // returned here (not in SubscriptionState, which tenants see) so
          // the manage sheet can prefill it instead of blanking it.
          const sub = await tx.query.organizationSubscriptions.findFirst({
            where: (row, { eq: eq2 }) => eq2(row.orgId, org.id),
            columns: { note: true },
          });
          return {
            orgId: org.id,
            name: org.name,
            slug: org.slug,
            createdAt: org.createdAt.toISOString(),
            note: sub?.note ?? null,
            subscription: await readSubscriptionState(tx, org.id),
          };
        }),
      );
    });
  }),

  updateSubscription: authedProcedure
    .input(SubscriptionUpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      await requirePlatformAdmin(ctx.db, ctx.session!.userId);
      return withSystemContext(ctx.db, 'auth', async (tx) => {
        const org = await tx.query.organizations.findFirst({
          where: (o, { eq: eq2 }) => eq2(o.id, input.orgId),
        });
        if (!org) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.orgNotFound' });
        }
        const plan = await tx.query.billingPlans.findFirst({
          where: (p, { eq: eq2 }) => eq2(p.code, input.planCode),
        });
        if (!plan) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'platform.errors.planNotFound' });
        }

        // 2026-10-21 audit CA-39 (A-13): fields the caller did not send
        // keep their stored value. Previously every omitted date became
        // NULL and the note was overwritten on each save.
        const dates = {
          trialEndsAt: parseOptionalDate(input.trialEndsAt),
          currentPeriodStart: parseOptionalDate(input.currentPeriodStart),
          currentPeriodEnd: parseOptionalDate(input.currentPeriodEnd),
          graceEndsAt: parseOptionalDate(input.graceEndsAt),
        };
        const note = input.note === undefined ? undefined : input.note?.trim() || null;
        const before = await tx.query.organizationSubscriptions.findFirst({
          where: (sub, { eq: eq2 }) => eq2(sub.orgId, input.orgId),
        });
        const set: Partial<typeof s.organizationSubscriptions.$inferInsert> = {
          planCode: input.planCode,
          status: input.status,
          updatedBy: ctx.session!.userId,
          updatedAt: new Date(),
        };
        for (const [key, value] of Object.entries(dates) as Array<
          [keyof typeof dates, Date | null | undefined]
        >) {
          if (value !== undefined) set[key] = value;
        }
        if (input.cancelAtPeriodEnd !== undefined) set.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
        if (note !== undefined) set.note = note;
        await tx
          .insert(s.organizationSubscriptions)
          .values({
            orgId: input.orgId,
            planCode: input.planCode,
            status: input.status,
            trialEndsAt: dates.trialEndsAt ?? null,
            currentPeriodStart: dates.currentPeriodStart ?? null,
            currentPeriodEnd: dates.currentPeriodEnd ?? null,
            graceEndsAt: dates.graceEndsAt ?? null,
            cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
            note: note ?? null,
            updatedBy: ctx.session!.userId,
          })
          .onConflictDoUpdate({ target: s.organizationSubscriptions.orgId, set });
        // 2026-10-21 audit CA-39 (A-13): plan / status changes are now
        // visible in the tenant's admin audit trail. The free-text note is
        // platform-internal, so only whether it changed is recorded.
        await tx.insert(s.policyDecisions).values({
          orgId: input.orgId,
          actorId: ctx.session!.userId,
          action: 'platform.subscription.update',
          resourceType: 'subscription',
          resourceId: input.orgId,
          decision: 'allow',
          inputs: {
            before: before
              ? {
                  planCode: before.planCode,
                  status: before.status,
                  trialEndsAt: before.trialEndsAt?.toISOString() ?? null,
                  currentPeriodStart: before.currentPeriodStart?.toISOString() ?? null,
                  currentPeriodEnd: before.currentPeriodEnd?.toISOString() ?? null,
                  graceEndsAt: before.graceEndsAt?.toISOString() ?? null,
                  cancelAtPeriodEnd: before.cancelAtPeriodEnd,
                }
              : null,
            planCode: input.planCode,
            status: input.status,
            trialEndsAt: input.trialEndsAt,
            currentPeriodStart: input.currentPeriodStart,
            currentPeriodEnd: input.currentPeriodEnd,
            graceEndsAt: input.graceEndsAt,
            cancelAtPeriodEnd: input.cancelAtPeriodEnd,
            noteChanged: note !== undefined && note !== (before?.note ?? null),
          },
        });
        await tx
          .update(s.organizations)
          .set({ plan: input.planCode, updatedAt: new Date() })
          .where(eq(s.organizations.id, input.orgId));
        return readSubscriptionState(tx, input.orgId);
      });
    }),
});
