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
  type SettlementOperatingExpenseItem,
  SettlementRecentInputSchema,
  type SettlementSaveInput,
  SettlementSaveInputSchema,
  type SettlementWageItem,
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

const DETAIL_FIELDS = ['operatingExpenseItems', 'wageItems'] as const;
const CREATED_FIELDS = [...MONEY_FIELDS, ...DETAIL_FIELDS, 'note'] as const;
const MAX_SETTLEMENT_CENTS = 99_999_999_999_999n;

type OperatingExpenseItem = Omit<SettlementOperatingExpenseItem, 'paidTo'> & {
  paidTo: string | null;
};
type WageItem = SettlementWageItem;

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

/** Convert a validated positive decimal amount to integer cents without float drift. */
function settlementMoneyToCents(value: string): bigint {
  const normalized = normalizeSettlementMoney(value);
  const [whole, fraction] = normalized.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt(fraction ?? '0');
}

function centsToSettlementMoney(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

function detailValidation(field: string, reason: string): never {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'common.errors.validation',
    cause: { field, reason },
  });
}

function sumSettlementItems(values: readonly string[], field: string): string {
  let cents = 0n;
  for (const value of values) {
    cents += settlementMoneyToCents(value);
    if (cents > MAX_SETTLEMENT_CENTS) detailValidation(field, 'total-too-large');
  }
  return centsToSettlementMoney(cents);
}

function normalizeOperatingExpenseItems(
  items: readonly SettlementOperatingExpenseItem[],
): OperatingExpenseItem[] {
  return items.map((item) => ({
    category: item.category,
    item: item.item.trim(),
    amount: normalizeSettlementMoney(item.amount),
    paidTo: item.paidTo?.trim() || null,
    reason: item.reason.trim(),
  }));
}

function normalizeWageItems(items: readonly SettlementWageItem[]): WageItem[] {
  return items.map((item) => ({
    personName: item.personName.trim(),
    status: item.status,
    amount: normalizeSettlementMoney(item.amount),
    reason: item.reason.trim(),
  }));
}

function legacyOperatingExpenseItems(total: string): OperatingExpenseItem[] {
  return total === '0.00'
    ? []
    : [
        {
          category: 'other',
          item: 'Historical operating expense',
          amount: total,
          paidTo: null,
          reason:
            'Imported from a total-only daily close; the original item detail was not recorded.',
        },
      ];
}

function legacyWageItems(paid: string, unpaid: string): WageItem[] {
  const items: WageItem[] = [];
  if (paid !== '0.00') {
    items.push({
      personName: 'Unspecified recipient (historical total)',
      status: 'paid',
      amount: paid,
      reason: 'Imported from a total-only daily close; the recipient detail was not recorded.',
    });
  }
  if (unpaid !== '0.00') {
    items.push({
      personName: 'Unspecified recipient (historical total)',
      status: 'unpaid',
      amount: unpaid,
      reason: 'Imported from a total-only daily close; the recipient detail was not recorded.',
    });
  }
  return items;
}

function sameOperatingExpenseItems(
  left: readonly OperatingExpenseItem[],
  right: readonly OperatingExpenseItem[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameWageItems(left: readonly WageItem[], right: readonly WageItem[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function storedOperatingExpenseItems(row: SettlementRow): OperatingExpenseItem[] {
  // Rows written before itemization (or imported through a legacy path) may
  // legitimately contain only a scalar total. Surface a transparent legacy
  // row instead of showing a zero total to the editor and risking a deletion
  // on the next save.
  const operatingTotal = normalizeSettlementMoney(row.operatingExpenses);
  if (row.operatingExpenseItems.length === 0 && operatingTotal !== '0.00') {
    return legacyOperatingExpenseItems(operatingTotal);
  }
  return row.operatingExpenseItems.map((item) => ({
    category: item.category,
    item: item.item,
    amount: normalizeSettlementMoney(item.amount),
    paidTo: item.paidTo ?? null,
    reason: item.reason,
  }));
}

function storedWageItems(row: SettlementRow): WageItem[] {
  const paidTotal = normalizeSettlementMoney(row.wagesPaid);
  const unpaidTotal = normalizeSettlementMoney(row.wagesAccrued);
  if (row.wageItems.length === 0 && (paidTotal !== '0.00' || unpaidTotal !== '0.00')) {
    return legacyWageItems(paidTotal, unpaidTotal);
  }
  return row.wageItems.map((item) => ({
    personName: item.personName,
    status: item.status,
    amount: normalizeSettlementMoney(item.amount),
    reason: item.reason,
  }));
}

/**
 * Detail arrays are the authoritative source for the three cost totals.
 * Keeping the scalar inputs in the contract lets the API detect a malformed
 * or stale client. An older client may re-save an unchanged existing close,
 * but it cannot create or alter a non-zero outflow without its explanation.
 */
function resolveItemizedOutflows(input: SettlementSaveInput, existing: SettlementRow | undefined) {
  const submittedOperatingTotal = normalizeSettlementMoney(input.operatingExpenses);
  const submittedPaidTotal = normalizeSettlementMoney(input.wagesPaid);
  const submittedUnpaidTotal = normalizeSettlementMoney(input.wagesAccrued);

  let operatingExpenseItems: OperatingExpenseItem[];
  let operatingExpenses: string;
  if (input.operatingExpenseItems !== undefined) {
    operatingExpenseItems = normalizeOperatingExpenseItems(input.operatingExpenseItems);
    operatingExpenses = sumSettlementItems(
      operatingExpenseItems.map((item) => item.amount),
      'operatingExpenseItems',
    );
    if (operatingExpenses !== submittedOperatingTotal) {
      detailValidation('operatingExpenseItems', 'total-mismatch');
    }
  } else if (existing) {
    if (submittedOperatingTotal !== existing.operatingExpenses) {
      detailValidation('operatingExpenseItems', 'details-required');
    }
    operatingExpenseItems = storedOperatingExpenseItems(existing);
    operatingExpenses = existing.operatingExpenses;
  } else {
    if (submittedOperatingTotal !== '0.00') {
      detailValidation('operatingExpenseItems', 'details-required');
    }
    operatingExpenses = '0.00';
    operatingExpenseItems = [];
  }

  let wageItems: WageItem[];
  let wagesPaid: string;
  let wagesAccrued: string;
  if (input.wageItems !== undefined) {
    wageItems = normalizeWageItems(input.wageItems);
    wagesPaid = sumSettlementItems(
      wageItems.filter((item) => item.status === 'paid').map((item) => item.amount),
      'wageItems',
    );
    wagesAccrued = sumSettlementItems(
      wageItems.filter((item) => item.status === 'unpaid').map((item) => item.amount),
      'wageItems',
    );
    if (wagesPaid !== submittedPaidTotal || wagesAccrued !== submittedUnpaidTotal) {
      detailValidation('wageItems', 'total-mismatch');
    }
  } else if (existing) {
    if (
      submittedPaidTotal !== existing.wagesPaid ||
      submittedUnpaidTotal !== existing.wagesAccrued
    ) {
      detailValidation('wageItems', 'details-required');
    }
    wageItems = storedWageItems(existing);
    wagesPaid = existing.wagesPaid;
    wagesAccrued = existing.wagesAccrued;
  } else {
    if (submittedPaidTotal !== '0.00' || submittedUnpaidTotal !== '0.00') {
      detailValidation('wageItems', 'details-required');
    }
    wagesPaid = '0.00';
    wagesAccrued = '0.00';
    wageItems = [];
  }

  return {
    operatingExpenseItems,
    operatingExpenses,
    wageItems,
    wagesPaid,
    wagesAccrued,
  };
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
    operatingExpenseItems: storedOperatingExpenseItems(row),
    wageItems: storedWageItems(row),
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
    operatingExpenseItems: storedOperatingExpenseItems(row),
    wageItems: storedWageItems(row),
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

      const itemizedOutflows = resolveItemizedOutflows(input, existing);
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
          !sameOperatingExpenseItems(
            storedOperatingExpenseItems(existing),
            values.operatingExpenseItems,
          )
        ) {
          changedFields.push('operatingExpenseItems');
        }
        if (!sameWageItems(storedWageItems(existing), values.wageItems)) {
          changedFields.push('wageItems');
        }
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
