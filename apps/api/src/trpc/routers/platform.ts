import { TRPCError } from '@trpc/server';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, withSystemContext } from '@compass/db';
import { isCalendarDate, SubscriptionStatusSchema, UuidSchema } from '@compass/contracts';
import { attendance } from '@compass/domain';
import { authedProcedure, router } from '../trpc';
import { isPlatformAdmin } from '../../services/platformAdmin';
import { readSubscriptionState, readSubscriptionStates } from '../../services/subscription';
import { hub } from '../../realtime/hub';

const SubscriptionUpdateInputSchema = z.object({
  orgId: UuidSchema,
  planCode: z.string().min(1).max(32),
  status: SubscriptionStatusSchema,
  trialEndsAt: z.string().nullable().optional(),
  currentPeriodStart: z.string().nullable().optional(),
  currentPeriodEnd: z.string().nullable().optional(),
  graceEndsAt: z.string().nullable().optional(),
  // 2026-10-21 audit CA-39: optional (not default(false)) so an omitted
  // flag keeps the stored value instead of silently clearing it.
  cancelAtPeriodEnd: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

/**
 * RE-AUTH-3 (2026-10-31): only "YYYY-MM-DD" or a full ISO timestamp with
 * a zone. `new Date()` read "2026-1-5" in the server's own zone (stored as
 * 4 January 19:00 UTC) and "0000-01-01" as a real day, which Postgres then
 * refused as a 500.
 */
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Review ADM1-32: a bare day is a day of the organisation's own calendar.
 * An end runs to the end of that day there and a start begins with it.
 * Both were read in UTC, at the end of the day, so an end in Tashkent fell
 * five hours into the next day and a start nearly a day late.
 */
function parseDate(
  value: string | null | undefined,
  timeZone: string,
  edge: 'start' | 'end',
): Date | null {
  if (!value) return null;
  const invalid = () =>
    new TRPCError({ code: 'BAD_REQUEST', message: 'platform.errors.invalidDate' });
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const datePart = dayOnly ? value : ISO_TIMESTAMP.exec(value)?.[1];
  // AUTH-23 (2026-10-30): "2026-02-30" used to roll over to 2 March.
  if (!datePart || !isCalendarDate(datePart)) throw invalid();
  if (!dayOnly) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw invalid();
    return date;
  }
  const dayStart = (day: string) => attendance.zonedTimeToUtc(day, '00:00', timeZone);
  if (edge === 'start') return dayStart(value);
  return new Date(dayStart(attendance.nextDate(value)).getTime() - 1);
}

/**
 * 2026-10-21 audit CA-39 (A-13): `undefined` means "leave as is", `null`
 * (or an empty string) means "clear". Returns undefined for omitted
 * fields so the upsert's SET clause can skip them.
 */
function parseOptionalDate(
  value: string | null | undefined,
  timeZone: string,
  edge: 'start' | 'end' = 'end',
): Date | null | undefined {
  if (value === undefined) return undefined;
  return parseDate(value, timeZone, edge);
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
      // Review NEW-PLATFORM-N1 (2026-11-12): five queries for the whole
      // list, not four for each org.
      const orgIds = orgs.map((org) => org.id);
      const subscriptionOf = await readSubscriptionStates(tx, orgIds);
      // 2026-10-21 audit CA-39 (A-13): the platform-internal note is
      // returned here (not in SubscriptionState, which tenants see) so
      // the manage sheet can prefill it instead of blanking it.
      const notes = await tx
        .select({
          orgId: s.organizationSubscriptions.orgId,
          note: s.organizationSubscriptions.note,
        })
        .from(s.organizationSubscriptions)
        .where(inArray(s.organizationSubscriptions.orgId, orgIds));
      const noteOf = new Map(notes.map((row) => [row.orgId, row.note]));
      return orgs.map((org) => ({
        orgId: org.id,
        name: org.name,
        slug: org.slug,
        // Review ADM1-32: the sheet shows and sends the dates as days
        // of this calendar.
        timezone: org.timezone,
        createdAt: org.createdAt.toISOString(),
        note: noteOf.get(org.id) ?? null,
        subscription: subscriptionOf(org.id),
      }));
    });
  }),

  updateSubscription: authedProcedure
    .input(SubscriptionUpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      await requirePlatformAdmin(ctx.db, ctx.session!.userId);
      const state = await withSystemContext(ctx.db, 'auth', async (tx) => {
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
          trialEndsAt: parseOptionalDate(input.trialEndsAt, org.timezone),
          currentPeriodStart: parseOptionalDate(input.currentPeriodStart, org.timezone, 'start'),
          currentPeriodEnd: parseOptionalDate(input.currentPeriodEnd, org.timezone),
          graceEndsAt: parseOptionalDate(input.graceEndsAt, org.timezone),
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
      // AUTH-18 (2026-10-30): members online in that organisation kept
      // their old subscription state (no read-only banner after a suspend)
      // until a reload. people.changed makes every client re-read its
      // session, the platform admin's own included.
      hub.publish(input.orgId, { type: 'people.changed', orgId: input.orgId });
      return state;
    }),
});
