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
  cancelAtPeriodEnd: z.boolean().default(false),
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
        orgs.map(async (org) => ({
          orgId: org.id,
          name: org.name,
          slug: org.slug,
          createdAt: org.createdAt.toISOString(),
          subscription: await readSubscriptionState(tx, org.id),
        })),
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

        const values = {
          orgId: input.orgId,
          planCode: input.planCode,
          status: input.status,
          trialEndsAt: parseDate(input.trialEndsAt),
          currentPeriodStart: parseDate(input.currentPeriodStart),
          currentPeriodEnd: parseDate(input.currentPeriodEnd),
          graceEndsAt: parseDate(input.graceEndsAt),
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          note: input.note?.trim() || null,
          updatedBy: ctx.session!.userId,
        };
        await tx
          .insert(s.organizationSubscriptions)
          .values(values)
          .onConflictDoUpdate({
            target: s.organizationSubscriptions.orgId,
            set: {
              planCode: values.planCode,
              status: values.status,
              trialEndsAt: values.trialEndsAt,
              currentPeriodStart: values.currentPeriodStart,
              currentPeriodEnd: values.currentPeriodEnd,
              graceEndsAt: values.graceEndsAt,
              cancelAtPeriodEnd: values.cancelAtPeriodEnd,
              note: values.note,
              updatedBy: values.updatedBy,
              updatedAt: new Date(),
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
