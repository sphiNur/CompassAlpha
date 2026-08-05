/**
 * Per-store daily closing ledger.
 *
 * Authorization is deliberately resolved for the concrete store on every
 * route. The session permission set is flattened for UI affordances and must
 * never be sufficient for a store-scoped financial read or write.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import {
  SettlementBusinessDateInputSchema,
  SettlementGetInputSchema,
  SettlementRecentInputSchema,
  SettlementSaveInputSchema,
} from '@compass/contracts';
import { todayInTz } from '@compass/domain';
import { authedProcedure, idempotentMutation, router } from '../trpc';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
} from '../../services/storeScope';

type SettlementRow = typeof s.storeDailySettlements.$inferSelect;

type SettlementSession = {
  memberId: string;
  orgId: string;
  orgTimezone: string;
  permissions: ReadonlySet<string>;
};

const MONEY_FIELDS = [
  'onlineRevenue',
  'invoicedCashRevenue',
  'operatingExpenses',
  'wagesPaid',
  'wagesAccrued',
  'nextPurchaseReserve',
  'priorPurchaseAdjustment',
  'cashOnHand',
] as const;

const CREATED_FIELDS = [...MONEY_FIELDS, 'note'] as const;

/**
 * Normalize a contract-validated amount to the same two-decimal shape that
 * Postgres NUMERIC(14,2) returns. This prevents a value such as `10` from
 * being reported as a change to an existing `10.00` row.
 */
export function normalizeSettlementMoney(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [wholeRaw = '0', fractionRaw = ''] = unsigned.split('.');
  const whole = BigInt(wholeRaw || '0').toString();
  const fraction = fractionRaw.padEnd(2, '0').slice(0, 2);
  const isZero = whole === '0' && fraction === '00';
  return `${negative && !isZero ? '-' : ''}${whole}.${fraction}`;
}

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

async function memberNameMap(
  tx: DB,
  memberIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(memberIds.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({
      memberId: s.members.id,
      displayName: s.users.displayName,
    })
    .from(s.members)
    .innerJoin(s.users, eq(s.users.id, s.members.userId))
    .where(inArray(s.members.id, unique));
  return new Map(rows.map((row) => [row.memberId, row.displayName]));
}

async function serializeSettlements(tx: DB, rows: SettlementRow[]) {
  const names = await memberNameMap(
    tx,
    rows.flatMap((row) => [row.createdByMemberId, row.updatedByMemberId]),
  );
  return rows.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    date: row.settlementDate,
    onlineRevenue: row.onlineRevenue,
    invoicedCashRevenue: row.invoicedCashRevenue,
    operatingExpenses: row.operatingExpenses,
    wagesPaid: row.wagesPaid,
    wagesAccrued: row.wagesAccrued,
    nextPurchaseReserve: row.nextPurchaseReserve,
    priorPurchaseAdjustment: row.priorPurchaseAdjustment,
    cashOnHand: row.cashOnHand,
    note: row.note,
    version: row.version,
    createdByMemberId: row.createdByMemberId,
    createdByName: row.createdByMemberId ? (names.get(row.createdByMemberId) ?? null) : null,
    updatedByMemberId: row.updatedByMemberId,
    updatedByName: row.updatedByMemberId ? (names.get(row.updatedByMemberId) ?? null) : null,
    /** Convenient generic actor fields for list/detail rows. */
    actorMemberId: row.updatedByMemberId,
    actorName: row.updatedByMemberId ? (names.get(row.updatedByMemberId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function revisionSnapshot(
  row: SettlementRow,
  actorMemberId: string,
  actorUserId: string,
  actorDisplayName: string | null,
): Record<string, unknown> {
  return {
    onlineRevenue: row.onlineRevenue,
    invoicedCashRevenue: row.invoicedCashRevenue,
    operatingExpenses: row.operatingExpenses,
    wagesPaid: row.wagesPaid,
    wagesAccrued: row.wagesAccrued,
    nextPurchaseReserve: row.nextPurchaseReserve,
    priorPurchaseAdjustment: row.priorPurchaseAdjustment,
    cashOnHand: row.cashOnHand,
    note: row.note,
    version: row.version,
    updatedByMemberId: row.updatedByMemberId,
    actorMemberId,
    actorUserId,
    actorDisplayName,
    updatedAt: row.updatedAt.toISOString(),
  };
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
        const timezone = store.timezone || ctx.session!.orgTimezone;
        return {
          storeId: store.id,
          date: todayInTz(timezone),
          timezone,
        };
      });
    }),

  /** One store's settlement for a business date, or null when not filed. */
  get: authedProcedure.input(SettlementGetInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const store = await authorizeSettlementStore(tx, ctx.session!, input.storeId);
      const date = input.date ?? todayInTz(store.timezone || ctx.session!.orgTimezone);
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
      const storeToday = todayInTz(store.timezone || ctx.session!.orgTimezone);
      const date = input.date ?? storeToday;
      if (!store.isActive || store.deletedAt) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'auth.errors.storeArchived',
        });
      }
      if (date > storeToday) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'common.errors.validation',
          cause: { field: 'date', reason: 'future-date' },
        });
      }

      const values = {
        onlineRevenue: normalizeSettlementMoney(input.onlineRevenue),
        invoicedCashRevenue: normalizeSettlementMoney(input.invoicedCashRevenue),
        operatingExpenses: normalizeSettlementMoney(input.operatingExpenses),
        wagesPaid: normalizeSettlementMoney(input.wagesPaid),
        wagesAccrued: normalizeSettlementMoney(input.wagesAccrued),
        nextPurchaseReserve: normalizeSettlementMoney(input.nextPurchaseReserve),
        priorPurchaseAdjustment: normalizeSettlementMoney(input.priorPurchaseAdjustment),
        cashOnHand: normalizeSettlementMoney(input.cashOnHand),
        note: input.note && input.note.length > 0 ? input.note : null,
      };
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
        if ((existing.note ?? null) !== values.note) changedFields.push('note');

        // An identical re-save is a true no-op: do not manufacture a new
        // financial revision just because the submit button was tapped twice.
        if (changedFields.length === 0) {
          return (await serializeSettlements(tx, [existing]))[0]!;
        }
        if (!correctionReason) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'common.errors.validation',
            cause: { field: 'correctionReason', reason: 'required-for-correction' },
          });
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

      return (await serializeSettlements(tx, [saved]))[0]!;
    });
  }),
});
