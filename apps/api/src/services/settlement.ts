/**
 * The daily close's rules (review CONF-09, 2026-11): amounts, the detail
 * rows that decide the three cost totals, closes recorded before
 * itemization, the API shape and the revision snapshot. They filled the
 * first 760 lines of the settlement router, which now authorizes the store
 * and calls them.
 */
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import {
  type SettlementOperatingExpenseItem,
  type SettlementSaveInput,
  type SettlementWageItem,
  centsToMoney,
  toCents,
} from '@compass/contracts';
import { SETTLEMENT_MAX_CENTS } from '@compass/contracts/limits';
import { stableJson } from './stableJson';
import type { WageRosterMember } from './wageRoster';

export type SettlementRow = typeof s.storeDailySettlements.$inferSelect;

export const MONEY_FIELDS = [
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
export const CREATED_FIELDS = [...MONEY_FIELDS, ...DETAIL_FIELDS, 'note'] as const;

export type RawOperatingExpenseItem = SettlementRow['operatingExpenseItems'][number];
export type RawWageItem = SettlementRow['wageItems'][number];

/** API output: the row ID is opaque and attribution remains server-only. */
type OperatingExpenseItem = {
  id: string | null;
  amount: string;
  reason: string;
  /** True only for a legacy scalar total synthesised for safe display. */
  isHistorical: boolean;
};

/** API output: memberId may be absent only for untouched historical data. */
type WageItem = {
  id: string | null;
  memberId: string | null;
  personName: string;
  status: 'paid' | 'unpaid';
  amount: string;
  reason: string;
  isHistorical: boolean;
};

/**
 * Normalize a contract-validated amount to the same two-decimal shape that
 * Postgres NUMERIC(14,2) returns. This prevents a value such as `10` from
 * being reported as a change to an existing `10.00` row. CONF-08: through
 * the shared cents helpers, which get a negative amount right (the private
 * pair here made `-4.50` into -350 cents and -450 cents into "-4.-50").
 */
export function normalizeSettlementMoney(value: string): string {
  return centsToMoney(toCents(value));
}

/**
 * The catalog sentence for each rejected-close reason, so the page can say
 * what to fix instead of "try again". The structured cause stays as it was.
 */
export const SETTLEMENT_REASON_KEYS: Record<string, string> = {
  'total-too-large': 'settlement.errors.totalTooLarge',
  'unknown-item': 'settlement.errors.unknownItem',
  'employee-selection-required': 'settlement.errors.employeeRequired',
  'employee-not-in-store': 'settlement.errors.employeeNotInStore',
  'historical-total-immutable': 'settlement.errors.historicalTotalImmutable',
  'total-mismatch': 'settlement.errors.totalMismatch',
  'details-required': 'settlement.errors.invalidDetails',
  'future-date': 'settlement.errors.futureDate',
  'too-old': 'settlement.errors.dateTooOld',
  'required-for-correction': 'settlement.errors.correctionReasonRequired',
};

export function detailValidation(
  field: string,
  reason: string,
  context?: Record<string, string | number>,
): never {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: SETTLEMENT_REASON_KEYS[reason] ?? 'common.errors.validation',
    // `context` fills the sentence's placeholders on the client (CMP-COPY-2).
    cause: context ? { field, reason, context } : { field, reason },
  });
}

function sumSettlementItems(values: readonly string[], field: string): string {
  let cents = 0n;
  for (const value of values) {
    cents += toCents(value);
    if (cents > SETTLEMENT_MAX_CENTS) detailValidation(field, 'total-too-large');
  }
  return centsToMoney(cents);
}

export function rawOperatingExpenseItems(row: SettlementRow): RawOperatingExpenseItem[] {
  return Array.isArray(row.operatingExpenseItems) ? row.operatingExpenseItems : [];
}

export function rawWageItems(row: SettlementRow): RawWageItem[] {
  return Array.isArray(row.wageItems) ? row.wageItems : [];
}

/**
 * A non-zero scalar with no rows predates itemization. It has no trustworthy
 * row-level author or reason, so it may be displayed but must never be
 * backfilled into a newly attributed detail array.
 */
function hasLegacyOperatingExpenseTotal(row: SettlementRow | undefined): boolean {
  return (
    !!row &&
    rawOperatingExpenseItems(row).length === 0 &&
    normalizeSettlementMoney(row.operatingExpenses) !== '0.00'
  );
}

function hasLegacyWageTotal(row: SettlementRow | undefined): boolean {
  return (
    !!row &&
    rawWageItems(row).length === 0 &&
    (normalizeSettlementMoney(row.wagesPaid) !== '0.00' ||
      normalizeSettlementMoney(row.wagesAccrued) !== '0.00')
  );
}

function rawItemId(item: RawOperatingExpenseItem): string | null {
  return typeof item.id === 'string' ? item.id : null;
}

function rawMemberId(item: RawWageItem): string | null {
  return typeof item.memberId === 'string' ? item.memberId : null;
}

function rawWageItemId(item: RawWageItem): string | null {
  return typeof item.id === 'string' ? item.id : null;
}

function rawText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sameExpenseValues(item: RawOperatingExpenseItem, amount: string, reason: string): boolean {
  return normalizeSettlementMoney(item.amount) === amount && rawText(item.reason).trim() === reason;
}

/**
 * Keep the original server attribution (and any pre-existing legacy keys)
 * when a client sends an unchanged row. A fresh expense receives a stable ID
 * and its original recorder exclusively from the authenticated session.
 */
function normalizeOperatingExpenseItems(
  items: readonly SettlementOperatingExpenseItem[],
  existingItems: readonly RawOperatingExpenseItem[],
  actorMemberId: string,
): RawOperatingExpenseItem[] {
  const usedExistingIndexes = new Set<number>();
  return items.map((item) => {
    const amount = normalizeSettlementMoney(item.amount);
    const reason = item.reason.trim();
    let existingIndex = -1;

    if (item.id) {
      existingIndex = existingItems.findIndex(
        (existing, index) => !usedExistingIndexes.has(index) && rawItemId(existing) === item.id,
      );
      if (existingIndex < 0) detailValidation('operatingExpenseItems', 'unknown-item');
    } else {
      // This semantic fallback keeps an older cached client from replacing an
      // unchanged post-deploy row merely because it does not know the new ID.
      existingIndex = existingItems.findIndex(
        (existing, index) =>
          !usedExistingIndexes.has(index) && sameExpenseValues(existing, amount, reason),
      );
    }

    if (existingIndex >= 0) {
      usedExistingIndexes.add(existingIndex);
      const existing = existingItems[existingIndex]!;
      if (!item.id) return existing;
      return { ...existing, amount, reason };
    }

    return {
      id: randomUUID(),
      amount,
      reason,
      enteredByMemberId: actorMemberId,
    };
  });
}

function sameWageValues(item: RawWageItem, input: SettlementWageItem): boolean {
  const legacyName = input.personName?.trim();
  const sameRecipient = legacyName
    ? rawText(item.personName).trim() === legacyName
    : !!input.memberId && rawMemberId(item) === input.memberId;
  return (
    sameRecipient &&
    item.status === input.status &&
    normalizeSettlementMoney(item.amount) === normalizeSettlementMoney(input.amount) &&
    rawText(item.reason).trim() === input.reason.trim()
  );
}

/**
 * A new wage row is always selected by memberId. Existing server-issued IDs
 * preserve the original member/name snapshot even after a person is renamed,
 * suspended, or moved to another store. `personName` is accepted only for an
 * unchanged older-client resave; it can never introduce or alter a recipient.
 */
function normalizeWageItems(
  items: readonly SettlementWageItem[],
  existingItems: readonly RawWageItem[],
  rosterByMemberId: ReadonlyMap<string, WageRosterMember>,
): RawWageItem[] {
  const usedExistingIndexes = new Set<number>();
  return items.map((item) => {
    const amount = normalizeSettlementMoney(item.amount);
    const reason = item.reason.trim();
    let existingIndex = -1;

    if (item.id) {
      existingIndex = existingItems.findIndex(
        (existing, index) => !usedExistingIndexes.has(index) && rawWageItemId(existing) === item.id,
      );
      if (existingIndex < 0) detailValidation('wageItems', 'unknown-item');
    } else {
      // Older clients have no server-issued ID. They may retain an unchanged
      // historical line, but cannot use its free-text name to create/change a
      // recipient.
      existingIndex = existingItems.findIndex(
        (existing, index) => !usedExistingIndexes.has(index) && sameWageValues(existing, item),
      );
    }

    if (existingIndex >= 0) {
      usedExistingIndexes.add(existingIndex);
      const existing = existingItems[existingIndex]!;
      if (!item.id) return existing;

      if (!item.memberId) {
        if (!sameWageValues(existing, item)) {
          detailValidation('wageItems', 'employee-selection-required');
        }
        return existing;
      }

      // Correcting amount/status/reason for the same person must retain the
      // original display-name snapshot and remain possible after that person
      // leaves the store. A different recipient is a real reassignment and
      // must still be present in today's scoped roster.
      if (rawMemberId(existing) === item.memberId) {
        return { ...existing, status: item.status, amount, reason };
      }
      const employee = rosterByMemberId.get(item.memberId);
      if (!employee) detailValidation('wageItems', 'employee-not-in-store');
      return {
        ...existing,
        memberId: item.memberId,
        personName: employee.displayName,
        status: item.status,
        amount,
        reason,
      };
    }

    if (!item.memberId) detailValidation('wageItems', 'employee-selection-required');
    const employee = rosterByMemberId.get(item.memberId);
    if (!employee) detailValidation('wageItems', 'employee-not-in-store');
    return {
      id: randomUUID(),
      memberId: item.memberId,
      personName: employee.displayName,
      status: item.status,
      amount,
      reason,
    };
  });
}

function legacyOperatingExpenseItems(total: string): OperatingExpenseItem[] {
  return total === '0.00'
    ? []
    : [
        {
          id: null,
          amount: total,
          reason: 'Historical total only; the original expense reason was not recorded.',
          isHistorical: true,
        },
      ];
}

function legacyWageItems(paid: string, unpaid: string): WageItem[] {
  const items: WageItem[] = [];
  if (paid !== '0.00') {
    items.push({
      id: null,
      memberId: null,
      personName: 'Unspecified recipient (historical total)',
      status: 'paid',
      amount: paid,
      reason: 'Imported from a total-only daily close; the recipient detail was not recorded.',
      isHistorical: true,
    });
  }
  if (unpaid !== '0.00') {
    items.push({
      id: null,
      memberId: null,
      personName: 'Unspecified recipient (historical total)',
      status: 'unpaid',
      amount: unpaid,
      reason: 'Imported from a total-only daily close; the recipient detail was not recorded.',
      isHistorical: true,
    });
  }
  return items;
}

/** The same rows, whichever order JSONB returned their keys in; arrays keep theirs. */
export function sameRawOperatingExpenseItems(
  left: readonly RawOperatingExpenseItem[],
  right: readonly RawOperatingExpenseItem[],
): boolean {
  return stableJson(left) === stableJson(right);
}

export function sameRawWageItems(
  left: readonly RawWageItem[],
  right: readonly RawWageItem[],
): boolean {
  return stableJson(left) === stableJson(right);
}
export async function memberNameMap(
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
  const rawItems = rawOperatingExpenseItems(row);
  if (rawItems.length === 0 && operatingTotal !== '0.00') {
    return legacyOperatingExpenseItems(operatingTotal);
  }
  return rawItems.map((item) => ({
    id: rawItemId(item),
    amount: normalizeSettlementMoney(item.amount),
    reason: rawText(item.reason),
    isHistorical: false,
  }));
}

function storedWageItems(row: SettlementRow): WageItem[] {
  const paidTotal = normalizeSettlementMoney(row.wagesPaid);
  const unpaidTotal = normalizeSettlementMoney(row.wagesAccrued);
  const rawItems = rawWageItems(row);
  if (rawItems.length === 0 && (paidTotal !== '0.00' || unpaidTotal !== '0.00')) {
    return legacyWageItems(paidTotal, unpaidTotal);
  }
  return rawItems.map((item) => ({
    id: rawWageItemId(item),
    memberId: rawMemberId(item),
    personName: rawText(item.personName) || 'Historical wage recipient',
    status: item.status,
    amount: normalizeSettlementMoney(item.amount),
    reason: rawText(item.reason),
    isHistorical: false,
  }));
}

/**
 * Detail arrays are the authoritative source for the three cost totals.
 * Keeping the scalar inputs in the contract lets the API detect a malformed
 * or stale client. An older client may re-save an unchanged existing close,
 * but it cannot create or alter a non-zero outflow without its explanation.
 */
export function resolveItemizedOutflows(
  input: SettlementSaveInput,
  existing: SettlementRow | undefined,
  actorMemberId: string,
  rosterByMemberId: ReadonlyMap<string, WageRosterMember>,
) {
  const submittedOperatingTotal = normalizeSettlementMoney(input.operatingExpenses);
  const submittedPaidTotal = normalizeSettlementMoney(input.wagesPaid);
  const submittedUnpaidTotal = normalizeSettlementMoney(input.wagesAccrued);

  const existingOperatingExpenseItems = existing ? rawOperatingExpenseItems(existing) : [];
  let operatingExpenseItems: RawOperatingExpenseItem[];
  let operatingExpenses: string;
  if (input.operatingExpenseItems !== undefined) {
    if (hasLegacyOperatingExpenseTotal(existing)) {
      detailValidation('operatingExpenseItems', 'historical-total-immutable');
    }
    operatingExpenseItems = normalizeOperatingExpenseItems(
      input.operatingExpenseItems,
      existingOperatingExpenseItems,
      actorMemberId,
    );
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
    operatingExpenseItems = existingOperatingExpenseItems;
    operatingExpenses = normalizeSettlementMoney(existing.operatingExpenses);
  } else {
    if (submittedOperatingTotal !== '0.00') {
      detailValidation('operatingExpenseItems', 'details-required');
    }
    operatingExpenses = '0.00';
    operatingExpenseItems = [];
  }

  const existingWageItems = existing ? rawWageItems(existing) : [];
  let wageItems: RawWageItem[];
  let wagesPaid: string;
  let wagesAccrued: string;
  if (input.wageItems !== undefined) {
    if (hasLegacyWageTotal(existing)) {
      detailValidation('wageItems', 'historical-total-immutable');
    }
    wageItems = normalizeWageItems(input.wageItems, existingWageItems, rosterByMemberId);
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
    wageItems = existingWageItems;
    wagesPaid = normalizeSettlementMoney(existing.wagesPaid);
    wagesAccrued = normalizeSettlementMoney(existing.wagesAccrued);
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

export async function serializeSettlements(tx: DB, rows: SettlementRow[]) {
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

export function revisionSnapshot(
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
    // Snapshot the persisted JSON, never a display-only virtual legacy row.
    // This keeps a total-only historical close byte-for-byte truthful even
    // when an unrelated field is corrected later.
    operatingExpenseItems: rawOperatingExpenseItems(row),
    wageItems: rawWageItems(row),
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

const ChangedFieldsSchema = z.array(z.string());

/**
 * A revision's `changed_fields` (jsonb) as the history lists them. Review
 * CONF-26: the value was cast to string[] unread; anything that is not a
 * list of field names now reads as none.
 */
export function revisionChangedFields(value: unknown): string[] {
  const parsed = ChangedFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
