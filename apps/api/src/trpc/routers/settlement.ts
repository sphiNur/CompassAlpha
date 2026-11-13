/**
 * Per-store daily closing ledger.
 *
 * Authorization is deliberately resolved for the concrete store on every
 * route. The session permission set is flattened for UI affordances and must
 * never be sufficient for a store-scoped financial read or write.
 */
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import {
  SettlementBusinessDateInputSchema,
  SettlementExpenseTemplatesInputSchema,
  SettlementGetInputSchema,
  SettlementRecentInputSchema,
  SettlementRevisionsInputSchema,
  SettlementSaveInputSchema,
  SettlementWageRosterInputSchema,
  BACKDATE_LIMIT_DAYS,
  isoDateDaysBefore,
} from '@compass/contracts';
import { todayInTz } from '@compass/domain';
import { authedProcedure, idempotentMutation, router } from '../trpc';
import { hub } from '../../realtime/hub';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
} from '../../services/storeScope';
import { storeTimeZone } from '../../services/timeZone';
import {
  CREATED_FIELDS,
  MONEY_FIELDS,
  type SettlementRow,
  detailValidation,
  memberNameMap,
  normalizeSettlementMoney,
  rawOperatingExpenseItems,
  rawWageItems,
  resolveItemizedOutflows,
  revisionChangedFields,
  revisionSnapshot,
  sameRawOperatingExpenseItems,
  sameRawWageItems,
  serializeSettlements,
} from '../../services/settlement';
import { loadWageRoster } from '../../services/wageRoster';
import { readExpenseTemplates } from '../../services/expenseTemplates';

type SettlementSession = {
  memberId: string;
  orgId: string;
  orgTimezone: string;
  permissions: ReadonlySet<string>;
};

function missingSettlementPermission(): never {
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.missingPermission',
    cause: { missingPermission: 'settlement.record' },
  });
}

function staleSettlement(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    // Existing translated copy already says another person edited the row.
    message: 'order.errors.staleSeq',
  });
}

/**
 * Check all three boundaries for a settlement route:
 *   1. the store belongs to this organization;
 *   2. the actor is assigned to the store (global org admins bypass through
 *      the existing persisted-provenance helper);
 *   3. settlement.record is effective in this concrete store after scoped
 *      allow/deny overrides.
 */
async function authorizeSettlementStore(
  tx: DB,
  session: SettlementSession,
  storeId: string,
): Promise<typeof s.stores.$inferSelect> {
  const store = await tx.query.stores.findFirst({
    where: (st, { and: and2, eq: eq2 }) => and2(eq2(st.id, storeId), eq2(st.orgId, session.orgId)),
  });
  if (!store) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'admin.errors.storeNotFound',
    });
  }

  await assertActorAssignedToStore(tx, session.memberId, storeId, session.permissions);
  const effective = await effectivePermissionsForStore(
    tx,
    session.memberId,
    storeId,
    session.permissions,
  );
  if (!effective.has('settlement.record')) missingSettlementPermission();

  return store;
}

export const settlementRouter = router({
  /**
   * Authoritative business date for the selected store. The browser must not
   * derive this from the device clock: employees can be travelling and two
   * stores in one organization may be on opposite sides of midnight.
   */
  businessDate: authedProcedure
    .input(SettlementBusinessDateInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const store = await authorizeSettlementStore(tx, ctx.session!, input.storeId);
        const timezone = storeTimeZone(store.timezone, ctx.session!.orgTimezone);
        return {
          storeId: store.id,
          date: todayInTz(timezone),
          timezone,
          // UI affordance only. Operating expenses are part of the daily
          // close, so anyone who may record this store's settlement (the
          // settlement.record check above) may record them too. Kept in the
          // response so already-loaded web bundles keep enabling the editor.
          canRecordOperatingExpenses: true,
        };
      });
    }),

  /**
   * Active personnel in this store, with only their effective store roles.
   * S4 (2026-11-13): and each one's daily wage on `date` (attendance
   * settings; null when none is set), which a new wage line starts from.
   * The close's own attendance fill (attendance.wageSuggestions) already
   * hands the same figure to whoever records the close.
   */
  wageRoster: authedProcedure
    .input(SettlementWageRosterInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const session = ctx.session!;
        const store = await authorizeSettlementStore(tx, session, input.storeId);
        if (!store.isActive || store.deletedAt) return [];
        const roster = await loadWageRoster(tx, session.orgId, store.id);
        if (roster.length === 0) return [];
        const date = input.date ?? todayInTz(storeTimeZone(store.timezone, session.orgTimezone));
        const rates = await tx
          .select({
            memberId: s.attendancePayRates.memberId,
            dailyWage: s.attendancePayRates.dailyWage,
          })
          .from(s.attendancePayRates)
          .where(
            and(
              eq(s.attendancePayRates.orgId, session.orgId),
              inArray(
                s.attendancePayRates.memberId,
                roster.map((member) => member.memberId),
              ),
              lte(s.attendancePayRates.effectiveFrom, date),
            ),
          )
          .orderBy(asc(s.attendancePayRates.effectiveFrom));
        // The latest rate in effect on the day, as the attendance sheet reads it.
        const wageOf = new Map<string, string>();
        for (const rate of rates) wageOf.set(rate.memberId, rate.dailyWage);
        return roster.map((member) => ({
          ...member,
          dailyWage: wageOf.get(member.memberId) ?? null,
        }));
      });
    }),

  /**
   * S5 (2026-11-13): the organisation's expense templates, offered on the
   * close as shortcuts that add a filled-in expense line. A default price
   * comes back only with prices.view in this store (null otherwise); the
   * line's amount is then typed.
   */
  expenseTemplates: authedProcedure
    .input(SettlementExpenseTemplatesInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const session = ctx.session!;
        const store = await authorizeSettlementStore(tx, session, input.storeId);
        const [templates, effective] = await Promise.all([
          readExpenseTemplates(tx, session, false),
          effectivePermissionsForStore(tx, session.memberId, store.id, session.permissions),
        ]);
        const showPrices = effective.has('prices.view');
        return templates.map((template) => ({
          id: template.id,
          label: template.label,
          unitHint: template.unitHint,
          defaultQty: template.defaultQty,
          defaultUnitPrice: showPrices ? template.defaultUnitPrice : null,
        }));
      });
    }),

  /** One store's settlement for a business date, or null when not filed. */
  get: authedProcedure.input(SettlementGetInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const store = await authorizeSettlementStore(tx, ctx.session!, input.storeId);
      const date = input.date ?? todayInTz(storeTimeZone(store.timezone, ctx.session!.orgTimezone));
      const row = await tx.query.storeDailySettlements.findFirst({
        where: (settlement, { and: and2, eq: eq2 }) =>
          and2(
            eq2(settlement.orgId, ctx.session!.orgId),
            eq2(settlement.storeId, input.storeId),
            eq2(settlement.settlementDate, date),
          ),
      });
      if (!row) return null;
      return (await serializeSettlements(tx, [row]))[0]!;
    });
  }),

  /**
   * CLS-20 (2026-10-30): every saved version of one daily close — who saved
   * it, when, which fields changed and the correction reason. The rows were
   * written on every save but nothing read them.
   */
  revisions: authedProcedure.input(SettlementRevisionsInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const settlement = await tx.query.storeDailySettlements.findFirst({
        where: (row, { and: and2, eq: eq2 }) =>
          and2(eq2(row.id, input.settlementId), eq2(row.orgId, ctx.session!.orgId)),
        columns: { storeId: true },
      });
      if (!settlement) return [];
      await authorizeSettlementStore(tx, ctx.session!, settlement.storeId);
      const rows = await tx
        .select({
          version: s.storeDailySettlementRevisions.version,
          createdAt: s.storeDailySettlementRevisions.createdAt,
          changedFields: s.storeDailySettlementRevisions.changedFields,
          correctionReason: s.storeDailySettlementRevisions.correctionReason,
          actorMemberId: s.storeDailySettlementRevisions.actorMemberId,
        })
        .from(s.storeDailySettlementRevisions)
        .where(
          and(
            eq(s.storeDailySettlementRevisions.orgId, ctx.session!.orgId),
            eq(s.storeDailySettlementRevisions.settlementId, input.settlementId),
          ),
        )
        .orderBy(desc(s.storeDailySettlementRevisions.version))
        .limit(50);
      const names = await memberNameMap(
        tx,
        rows.map((row) => row.actorMemberId),
      );
      return rows.map((row) => ({
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        changedFields: revisionChangedFields(row.changedFields),
        correctionReason: row.correctionReason,
        actorName: names.get(row.actorMemberId) ?? null,
      }));
    });
  }),

  /** Recent filings for one authorized store, newest business date first. */
  recent: authedProcedure.input(SettlementRecentInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      await authorizeSettlementStore(tx, ctx.session!, input.storeId);
      const rows = await tx
        .select()
        .from(s.storeDailySettlements)
        .where(
          and(
            eq(s.storeDailySettlements.orgId, ctx.session!.orgId),
            eq(s.storeDailySettlements.storeId, input.storeId),
            ...(input.beforeDate
              ? [lt(s.storeDailySettlements.settlementDate, input.beforeDate)]
              : []),
          ),
        )
        .orderBy(
          desc(s.storeDailySettlements.settlementDate),
          desc(s.storeDailySettlements.updatedAt),
        )
        .limit(input.limit);
      return serializeSettlements(tx, rows);
    });
  }),

  /**
   * Create or correct one daily filing. expectedVersion=0 is create-only;
   * updates compare-and-swap the current version so simultaneous cashiers
   * cannot silently overwrite each other.
   */
  save: idempotentMutation.input(SettlementSaveInputSchema).mutation(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const store = await authorizeSettlementStore(tx, ctx.session!, input.storeId);
      const storeToday = todayInTz(storeTimeZone(store.timezone, ctx.session!.orgTimezone));
      const date = input.date ?? storeToday;
      if (!store.isActive || store.deletedAt) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'auth.errors.storeArchived',
        });
      }
      if (date > storeToday) {
        detailValidation('date', 'future-date');
      }

      const correctionReason =
        input.correctionReason && input.correctionReason.length > 0 ? input.correctionReason : null;

      const existing = await tx.query.storeDailySettlements.findFirst({
        where: (settlement, { and: and2, eq: eq2 }) =>
          and2(
            eq2(settlement.orgId, ctx.session!.orgId),
            eq2(settlement.storeId, input.storeId),
            eq2(settlement.settlementDate, date),
          ),
      });

      // CLS-14 (2026-10-30): a new close at most BACKDATE_LIMIT_DAYS back.
      // Correcting an existing older close stays possible.
      if (!existing && date < isoDateDaysBefore(storeToday, BACKDATE_LIMIT_DAYS)) {
        detailValidation('date', 'too-old', { days: BACKDATE_LIMIT_DAYS });
      }

      const roster = input.wageItems?.some((item) => !!item.memberId)
        ? await loadWageRoster(tx, ctx.session!.orgId, store.id)
        : [];
      const itemizedOutflows = resolveItemizedOutflows(
        input,
        existing,
        ctx.session!.memberId,
        new Map(roster.map((member) => [member.memberId, member])),
      );
      const values = {
        onlineRevenue: normalizeSettlementMoney(input.onlineRevenue),
        invoicedCashRevenue: normalizeSettlementMoney(input.invoicedCashRevenue),
        operatingExpenses: itemizedOutflows.operatingExpenses,
        wagesPaid: itemizedOutflows.wagesPaid,
        wagesAccrued: itemizedOutflows.wagesAccrued,
        operatingExpenseItems: itemizedOutflows.operatingExpenseItems,
        wageItems: itemizedOutflows.wageItems,
        nextPurchaseReserve: normalizeSettlementMoney(input.nextPurchaseReserve),
        priorPurchaseAdjustment: normalizeSettlementMoney(input.priorPurchaseAdjustment),
        cashOnHand: normalizeSettlementMoney(input.cashOnHand),
        note: input.note && input.note.length > 0 ? input.note : null,
      };

      let saved: SettlementRow;
      let changedFields: string[];
      let revisionReason: string | null = null;

      if (!existing) {
        if (input.expectedVersion !== 0) staleSettlement();

        const [created] = await tx
          .insert(s.storeDailySettlements)
          .values({
            orgId: ctx.session!.orgId,
            storeId: input.storeId,
            settlementDate: date,
            ...values,
            version: 1,
            createdByMemberId: ctx.session!.memberId,
            updatedByMemberId: ctx.session!.memberId,
          })
          // The natural key also protects two concurrent version-0 creates.
          .onConflictDoNothing()
          .returning();
        if (!created) staleSettlement();
        saved = created;
        changedFields = [...CREATED_FIELDS];
      } else {
        if (input.expectedVersion !== existing.version) staleSettlement();

        changedFields = MONEY_FIELDS.filter((field) => existing[field] !== values[field]);
        if (
          !sameRawOperatingExpenseItems(
            rawOperatingExpenseItems(existing),
            values.operatingExpenseItems,
          )
        ) {
          changedFields.push('operatingExpenseItems');
        }
        if (!sameRawWageItems(rawWageItems(existing), values.wageItems)) {
          changedFields.push('wageItems');
        }
        if ((existing.note ?? null) !== values.note) changedFields.push('note');

        // An identical re-save is a true no-op: do not manufacture a new
        // financial revision just because the submit button was tapped twice.
        if (changedFields.length === 0) {
          return (await serializeSettlements(tx, [existing]))[0]!;
        }
        if (!correctionReason) {
          detailValidation('correctionReason', 'required-for-correction');
        }

        const now = new Date();
        const [updated] = await tx
          .update(s.storeDailySettlements)
          .set({
            ...values,
            version: sql`${s.storeDailySettlements.version} + 1`,
            updatedByMemberId: ctx.session!.memberId,
            updatedAt: now,
          })
          .where(
            and(
              eq(s.storeDailySettlements.id, existing.id),
              eq(s.storeDailySettlements.orgId, ctx.session!.orgId),
              eq(s.storeDailySettlements.storeId, input.storeId),
              eq(s.storeDailySettlements.version, input.expectedVersion),
            ),
          )
          .returning();
        if (!updated) staleSettlement();
        saved = updated;
        revisionReason = correctionReason;
      }

      // Strict audit: deliberately no catch. If the append-only API revision
      // cannot be written, ctx.withOrg rolls the settlement write back.
      const actorDisplayName =
        (await memberNameMap(tx, [ctx.session!.memberId])).get(ctx.session!.memberId) ?? null;
      await tx.insert(s.storeDailySettlementRevisions).values({
        settlementId: saved.id,
        orgId: saved.orgId,
        storeId: saved.storeId,
        settlementDate: saved.settlementDate,
        version: saved.version,
        snapshot: revisionSnapshot(
          saved,
          ctx.session!.memberId,
          ctx.session!.userId,
          actorDisplayName,
        ),
        changedFields,
        correctionReason: revisionReason,
        actorMemberId: ctx.session!.memberId,
      });
      // Review CONF-26: a save on another device used to show only as a
      // version conflict at the next Save. The push refreshes the recent
      // closes, their history and the nav dot, and the open form then loads
      // the newer version or says it is there (useSettlementForm). It is
      // sent after COMMIT; an identical re-save (returned above) sends none.
      hub.publish(saved.orgId, {
        type: 'settlement.changed',
        orgId: saved.orgId,
        storeId: saved.storeId,
      });

      return (await serializeSettlements(tx, [saved]))[0]!;
    });
  }),
});
