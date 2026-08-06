/**
 * Per-store daily closing ledger.
 *
 * Authorization is deliberately resolved for the concrete store on every
 * route. The session permission set is flattened for UI affordances and must
 * never be sufficient for a store-scoped financial read or write.
 */
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import {
  MANAGER_RANK,
  SettlementBusinessDateInputSchema,
  SettlementGetInputSchema,
  type SettlementOperatingExpenseItem,
  SettlementRecentInputSchema,
  type SettlementSaveInput,
  SettlementSaveInputSchema,
  type SettlementWageItem,
  SettlementWageRosterInputSchema,
} from '@compass/contracts';
import { todayInTz } from '@compass/domain';
import { authedProcedure, idempotentMutation, router } from '../trpc';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  getActorMaxActiveRoleRankInStore,
} from '../../services/storeScope';
import { hasGlobalOrgAdmin } from '../../services/orgAdmin';

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

type RawOperatingExpenseItem = SettlementRow['operatingExpenseItems'][number];
type RawWageItem = SettlementRow['wageItems'][number];

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

/** Deliberately omits rank/permissions: the picker needs only a role label. */
type WageRosterRole = { id: string; slug: string; name: string };
type WageRosterRoleWithRank = WageRosterRole & { rank: number };
type WageRosterMember = {
  memberId: string;
  displayName: string;
  roles: WageRosterRole[];
};

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

function rawOperatingExpenseItems(row: SettlementRow): RawOperatingExpenseItem[] {
  return Array.isArray(row.operatingExpenseItems) ? row.operatingExpenseItems : [];
}

function rawWageItems(row: SettlementRow): RawWageItem[] {
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

/** JSONB does not preserve object-key insertion order; arrays still do. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameRawOperatingExpenseItems(
  left: readonly RawOperatingExpenseItem[],
  right: readonly RawOperatingExpenseItem[],
): boolean {
  return stableJson(left) === stableJson(right);
}

function sameRawWageItems(left: readonly RawWageItem[], right: readonly RawWageItem[]): boolean {
  return stableJson(left) === stableJson(right);
}

function missingSettlementPermission(): never {
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.missingPermission',
    cause: { missingPermission: 'settlement.record' },
  });
}

function managerRequiredForOperatingExpenses(): never {
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'settlement.errors.expensesManagerOnly',
    cause: { minimumRoleRank: MANAGER_RANK },
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
function resolveItemizedOutflows(
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

/**
 * Minimal, store-scoped wage roster. It intentionally avoids admin.memberList:
 * cashiers need this picker, while the admin directory exposes organization-
 * wide data and requires users.manage. A person belongs to a store through an
 * explicit assignment or an active store-scoped role binding; global roles by
 * themselves never make every employee a wage recipient in every store.
 */
async function loadWageRoster(tx: DB, orgId: string, storeId: string): Promise<WageRosterMember[]> {
  const now = new Date();
  const activeMemberConditions = [
    eq(s.members.orgId, orgId),
    eq(s.members.status, 'active'),
    isNull(s.users.deletedAt),
  ] as const;
  const [assignmentRows, scopedRoleRows] = await Promise.all([
    tx
      .select({ memberId: s.memberStoreAssignments.memberId })
      .from(s.memberStoreAssignments)
      .innerJoin(s.members, eq(s.members.id, s.memberStoreAssignments.memberId))
      .innerJoin(s.users, eq(s.users.id, s.members.userId))
      .where(and(eq(s.memberStoreAssignments.storeId, storeId), ...activeMemberConditions)),
    tx
      .select({ memberId: s.memberRoleBindings.memberId })
      .from(s.memberRoleBindings)
      .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
      .innerJoin(s.users, eq(s.users.id, s.members.userId))
      .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
      .where(
        and(
          eq(s.memberRoleBindings.scopeType, 'store'),
          eq(s.memberRoleBindings.scopeId, storeId),
          eq(s.roles.orgId, orgId),
          or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
          ...activeMemberConditions,
        ),
      ),
  ]);
  const memberIds = [...new Set([...assignmentRows, ...scopedRoleRows].map((row) => row.memberId))];
  if (memberIds.length === 0) return [];

  const [people, roleRows] = await Promise.all([
    tx
      .select({ memberId: s.members.id, displayName: s.users.displayName })
      .from(s.members)
      .innerJoin(s.users, eq(s.users.id, s.members.userId))
      .where(and(inArray(s.members.id, memberIds), ...activeMemberConditions)),
    tx
      .select({
        memberId: s.memberRoleBindings.memberId,
        id: s.roles.id,
        slug: s.roles.slug,
        name: s.roles.name,
        rank: s.roles.rank,
      })
      .from(s.memberRoleBindings)
      .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
      .where(
        and(
          inArray(s.memberRoleBindings.memberId, memberIds),
          eq(s.roles.orgId, orgId),
          or(
            eq(s.memberRoleBindings.scopeType, 'global'),
            and(
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, storeId),
            ),
          ),
          or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
        ),
      ),
  ]);

  const rolesByMember = new Map<string, Map<string, WageRosterRoleWithRank>>();
  for (const row of roleRows) {
    const roles = rolesByMember.get(row.memberId) ?? new Map<string, WageRosterRoleWithRank>();
    roles.set(row.id, { id: row.id, slug: row.slug, name: row.name, rank: row.rank });
    rolesByMember.set(row.memberId, roles);
  }

  return people
    .map((person) => ({
      memberId: person.memberId,
      displayName: person.displayName,
      roles: [...(rolesByMember.get(person.memberId)?.values() ?? [])]
        .sort((left, right) => right.rank - left.rank || left.name.localeCompare(right.name))
        .map(({ id, slug, name }) => ({ id, slug, name })),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function canRecordOperatingExpenses(
  tx: DB,
  memberId: string,
  storeId: string,
): Promise<boolean> {
  return (
    (await hasGlobalOrgAdmin(tx, memberId)) ||
    (await getActorMaxActiveRoleRankInStore(tx, memberId, storeId)) >= MANAGER_RANK
  );
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
          // UI affordance only; save independently enforces the exact same
          // store-scoped role threshold.
          canRecordOperatingExpenses: await canRecordOperatingExpenses(
            tx,
            ctx.session!.memberId,
            store.id,
          ),
        };
      });
    }),

  /** Active personnel in this store, with only their effective store roles. */
  wageRoster: authedProcedure
    .input(SettlementWageRosterInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const store = await authorizeSettlementStore(tx, ctx.session!, input.storeId);
        if (!store.isActive || store.deletedAt) return [];
        return loadWageRoster(tx, ctx.session!.orgId, store.id);
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

      const actorCanRecordOperatingExpenses = await canRecordOperatingExpenses(
        tx,
        ctx.session!.memberId,
        store.id,
      );
      // Keep the manager boundary dominant for an attempted mutation, even
      // when the target is also an immutable total-only historical close.
      if (
        input.operatingExpenseItems !== undefined &&
        hasLegacyOperatingExpenseTotal(existing) &&
        !actorCanRecordOperatingExpenses
      ) {
        managerRequiredForOperatingExpenses();
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
      const operatingExpenseItemsChanged = !sameRawOperatingExpenseItems(
        existing ? rawOperatingExpenseItems(existing) : [],
        itemizedOutflows.operatingExpenseItems,
      );
      const operatingExpensesChanged =
        itemizedOutflows.operatingExpenses !==
        (existing ? normalizeSettlementMoney(existing.operatingExpenses) : '0.00');
      if (
        (operatingExpenseItemsChanged || operatingExpensesChanged) &&
        !actorCanRecordOperatingExpenses
      ) {
        managerRequiredForOperatingExpenses();
      }
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
