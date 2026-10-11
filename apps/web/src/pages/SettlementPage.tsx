/**
 * SettlementPage — one store's end-of-day cash close.
 *
 * A daily close is deliberately a small, explicit record rather than a
 * calculated sales report: the cashier records what happened and the API
 * keeps a versioned correction trail.  This screen therefore never infers
 * cash from other modules or silently overwrites an existing close.
 */
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import {
  Button,
  ChoiceGroup,
  EmptyState,
  ErrorState,
  Field,
  List,
  Money,
  Row,
  Section,
  Sheet,
  StatusChip,
} from '@compass/ui/kit';
import type { SettlementWageItem } from '@compass/contracts';
import { trpc } from '../lib/trpc';
import { registerStoreChangeGuard, useStoreContext } from '../components/StoreSwitcher';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { confirmNative } from '../lib/confirm';
import { useI18n } from '../hooks/useI18n';
import { formatMoney, currencyOf } from '../lib/format';
import { useAuthStore } from '../stores/authStore';
import { registerTabChangeGuard } from '../stores/navStore';

type MoneyField =
  | 'onlineRevenue'
  | 'invoicedCashRevenue'
  | 'operatingExpenses'
  | 'wagesPaid'
  | 'wagesAccrued'
  | 'nextPurchaseReserve'
  | 'priorPurchaseAdjustment'
  | 'cashOnHand';

type OperatingExpenseDraft = {
  id: string;
  persistedId: string | null;
  amount: string;
  reason: string;
  isHistorical: boolean;
};
type WageItemDraft = {
  id: string;
  persistedId: string | null;
  memberId: string | null;
  personName: string;
  status: SettlementWageItem['status'];
  amount: string;
  reason: string;
  isHistorical: boolean;
};
type OperatingExpenseRecordItem = {
  id: string | null;
  amount: string;
  reason: string;
  isHistorical: boolean;
};
type WageRecordItem = {
  id: string | null;
  memberId: string | null;
  personName: string;
  status: SettlementWageItem['status'];
  amount: string;
  reason: string;
  isHistorical: boolean;
};
type WageRosterMember = {
  memberId: string;
  displayName: string;
  roles: Array<{ id: string; slug: string; name: string }>;
};

type SettlementRecord = Record<MoneyField, string> & {
  id: string;
  storeId: string;
  date: string;
  note: string | null;
  version: number;
  updatedByName: string | null;
  updatedAt: string;
  operatingExpenseItems: OperatingExpenseRecordItem[];
  wageItems: WageRecordItem[];
};

type SettlementDraft = Record<MoneyField, string> & {
  note: string;
  correctionReason: string;
  operatingExpenseItems: OperatingExpenseDraft[];
  wageItems: WageItemDraft[];
};

const MONEY_FIELDS: readonly MoneyField[] = [
  'onlineRevenue',
  'invoicedCashRevenue',
  'operatingExpenses',
  'wagesPaid',
  'wagesAccrued',
  'nextPurchaseReserve',
  'priorPurchaseAdjustment',
  'cashOnHand',
];
const DIRECT_MONEY_FIELDS: readonly Exclude<
  MoneyField,
  'operatingExpenses' | 'wagesPaid' | 'wagesAccrued'
>[] = [
  'onlineRevenue',
  'invoicedCashRevenue',
  'nextPurchaseReserve',
  'priorPurchaseAdjustment',
  'cashOnHand',
];

const POSITIVE_MONEY = /^\d{1,12}(?:\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?\d{1,12}(?:\.\d{1,2})?$/;
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SETTLEMENT_CENTS = 99_999_999_999_999n;
const MAX_DETAIL_ITEMS = 100;
function emptyDraft(): SettlementDraft {
  return {
    onlineRevenue: '0',
    invoicedCashRevenue: '0',
    operatingExpenses: '0',
    wagesPaid: '0',
    wagesAccrued: '0',
    nextPurchaseReserve: '0',
    priorPurchaseAdjustment: '0',
    cashOnHand: '0',
    note: '',
    correctionReason: '',
    operatingExpenseItems: [],
    wageItems: [],
  };
}

function newDetailId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Keep database decimal strings safe for a number input without rounding. */
function toMoneyInput(value: string | null | undefined): string {
  const raw = String(value ?? '0').trim();
  if (!SIGNED_MONEY.test(raw)) return raw || '0';
  return raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function draftFromRecord(record: SettlementRecord): SettlementDraft {
  return {
    onlineRevenue: toMoneyInput(record.onlineRevenue),
    invoicedCashRevenue: toMoneyInput(record.invoicedCashRevenue),
    operatingExpenses: toMoneyInput(record.operatingExpenses),
    wagesPaid: toMoneyInput(record.wagesPaid),
    wagesAccrued: toMoneyInput(record.wagesAccrued),
    nextPurchaseReserve: toMoneyInput(record.nextPurchaseReserve),
    priorPurchaseAdjustment: toMoneyInput(record.priorPurchaseAdjustment),
    cashOnHand: toMoneyInput(record.cashOnHand),
    note: record.note ?? '',
    correctionReason: '',
    operatingExpenseItems: (record.operatingExpenseItems ?? []).map((item) => ({
      id: newDetailId(),
      persistedId: item.id,
      amount: toMoneyInput(item.amount),
      reason: item.reason,
      isHistorical: item.isHistorical,
    })),
    wageItems: (record.wageItems ?? []).map((item) => ({
      id: newDetailId(),
      persistedId: item.id,
      memberId: item.memberId,
      personName: item.personName,
      status: item.status,
      amount: toMoneyInput(item.amount),
      reason: item.reason,
      isHistorical: item.isHistorical,
    })),
  };
}

function moneyNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Match the API's two-decimal normalization when deciding if this is a correction. */
function normalizedMoney(value: string): string {
  const raw = value.trim();
  if (!SIGNED_MONEY.test(raw)) return raw;
  const negative = raw.startsWith('-');
  const cents = moneyToCents(negative ? raw.slice(1) : raw);
  if (cents === null) return raw;
  return `${negative && cents !== 0n ? '-' : ''}${centsToMoneyInput(cents)}`;
}

function isMoney(value: string, signed = false): boolean {
  const raw = value.trim();
  const expression = signed ? SIGNED_MONEY : POSITIVE_MONEY;
  if (!expression.test(raw)) return false;
  return moneyToCents(raw.startsWith('-') ? raw.slice(1) : raw) !== null;
}

function moneyToCents(value: string): bigint | null {
  const raw = value.trim();
  if (!POSITIVE_MONEY.test(raw)) return null;
  const [whole = '0', fraction = ''] = raw.split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return cents <= MAX_SETTLEMENT_CENTS ? cents : null;
}

function centsToMoneyInput(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function sumItemAmounts(items: readonly { amount: string }[]): {
  value: string;
  valid: boolean;
} {
  let cents = 0n;
  for (const item of items) {
    const itemCents = moneyToCents(item.amount);
    if (itemCents === null || itemCents <= 0n) return { value: '0.00', valid: false };
    cents += itemCents;
    if (cents > MAX_SETTLEMENT_CENTS) return { value: '0.00', valid: false };
  }
  return { value: centsToMoneyInput(cents), valid: true };
}

function isValidOperatingExpense(item: OperatingExpenseDraft): boolean {
  return (
    item.isHistorical || (item.reason.trim().length > 0 && (moneyToCents(item.amount) ?? 0n) > 0n)
  );
}

function isValidWageItem(item: WageItemDraft, requireSelectedMember: boolean): boolean {
  return (
    item.isHistorical ||
    ((!requireSelectedMember || !!item.memberId) &&
      item.reason.trim().length > 0 &&
      (moneyToCents(item.amount) ?? 0n) > 0n)
  );
}

function comparableOperatingExpenseItems(items: readonly OperatingExpenseDraft[]) {
  return items.map((item) => ({
    id: item.persistedId,
    amount: normalizedMoney(item.amount),
    reason: item.reason.trim(),
    isHistorical: item.isHistorical,
  }));
}

function comparableRecordOperatingExpenseItems(items: readonly OperatingExpenseRecordItem[]) {
  return items.map((item) => ({
    id: item.id,
    amount: normalizedMoney(item.amount),
    reason: item.reason.trim(),
    isHistorical: item.isHistorical,
  }));
}

function comparableWageItems(items: readonly WageItemDraft[] | readonly WageRecordItem[]) {
  return items.map((item) => ({
    id: 'persistedId' in item ? item.persistedId : item.id,
    memberId: item.memberId,
    personName: item.personName.trim(),
    status: item.status,
    amount: normalizedMoney(item.amount),
    reason: item.reason.trim(),
    isHistorical: item.isHistorical,
  }));
}

function sameDetailItems(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isVersionConflict(error: unknown): boolean {
  const candidate = error as { data?: { code?: string }; message?: string };
  return candidate.data?.code === 'CONFLICT' || candidate.message === 'order.errors.staleSeq';
}

function formatSignedMoney(value: number, currency: string): string {
  const formatted = formatMoney(Math.abs(value), currency);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

const confirmSettlement = confirmNative;

function confirmSettlementAction(message: string, onConfirm: () => void): void {
  void confirmSettlement(message).then((confirmed) => {
    if (confirmed) onConfirm();
  });
}

export function SettlementPage() {
  const i18n = useI18n();
  const toast = useToast();
  const session = useAuthStore((state) => state.session);
  const storeCtx = useStoreContext();
  const requestedStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const setCurrentStore = useAuthStore((state) => state.setCurrentStore);
  const storesQuery = trpc.catalog.stores.useQuery(
    { permission: 'settlement.record' },
    { enabled: !!session },
  );
  const eligibleStores = storesQuery.data ?? [];
  const currentStoreId =
    eligibleStores.find((store) => store.id === requestedStoreId)?.id ??
    eligibleStores[0]?.id ??
    null;
  const currency = currencyOf(session);
  const [date, setDate] = useState('');
  const [draft, setDraft] = useState<SettlementDraft>(emptyDraft);
  const [draftRecordKey, setDraftRecordKey] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [wagePickerFor, setWagePickerFor] = useState<string | null>(null);
  const [newWagePickerFor, setNewWagePickerFor] = useState<string | null>(null);
  const [wageRoleFilter, setWageRoleFilter] = useState('');
  const [wageSearch, setWageSearch] = useState('');
  /** The expense or wage line open for editing; `NEWEST` is the one just added. */
  const [editExpense, setEditExpense] = useState<string | null>(null);
  const [editWage, setEditWage] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const businessDateQuery = trpc.settlement.businessDate.useQuery(
    { storeId: currentStoreId ?? '' },
    { enabled: !!currentStoreId },
  );
  const businessDate =
    businessDateQuery.data?.storeId === currentStoreId ? businessDateQuery.data : null;
  const closeQuery = trpc.settlement.get.useQuery(
    { storeId: currentStoreId ?? '', date },
    {
      enabled:
        !!currentStoreId && !!businessDate && BUSINESS_DATE.test(date) && date <= businessDate.date,
    },
  );
  const recentQuery = trpc.settlement.recent.useQuery(
    { storeId: currentStoreId ?? '', limit: 7 },
    { enabled: !!currentStoreId },
  );
  // The picker loads only on demand. This returns a minimum, store-scoped
  // roster rather than the admin directory, so cashiers never receive data
  // about staff in other stores.
  const wageRosterQuery = trpc.settlement.wageRoster.useQuery(
    { storeId: currentStoreId ?? '' },
    { enabled: !!currentStoreId && !!wagePickerFor },
  );

  // Recover from a persisted/global store that the actor can see but where
  // settlement.record is denied. Keep the shell context aligned with the
  // page-local selector so navigation after a close stays in the same store.
  useEffect(() => {
    if (currentStoreId && currentStoreId !== requestedStoreId) {
      setCurrentStore(currentStoreId);
    }
  }, [currentStoreId, requestedStoreId, setCurrentStore]);

  // The server owns "today" because this is a store business date, not a
  // device date. Reset to that date whenever the selected store changes.
  useEffect(() => {
    if (businessDate) {
      setDate(businessDate.date);
    }
  }, [businessDate?.date, businessDate?.storeId]);

  useEffect(() => {
    setWagePickerFor(null);
    setNewWagePickerFor(null);
    setWageRoleFilter('');
    setWageSearch('');
  }, [currentStoreId]);

  // A date switch can briefly retain a previous query result. Only ever use
  // a response for the current store AND date shown in the form.
  const existing =
    closeQuery.data && closeQuery.data.storeId === currentStoreId && closeQuery.data.date === date
      ? (closeQuery.data as SettlementRecord)
      : null;
  const recordKey = `${currentStoreId ?? ''}:${date}:${existing?.id ?? 'new'}:${existing?.version ?? 0}`;

  useEffect(() => {
    if (!currentStoreId) {
      setDraftRecordKey(null);
      return;
    }
    setDraft(existing ? draftFromRecord(existing) : emptyDraft());
    setDraftRecordKey(recordKey);
    setVersionConflict(false);
  }, [currentStoreId, recordKey]);

  const operatingExpenseTotal = sumItemAmounts(draft.operatingExpenseItems);
  const paidWageTotal = sumItemAmounts(draft.wageItems.filter((item) => item.status === 'paid'));
  const unpaidWageTotal = sumItemAmounts(
    draft.wageItems.filter((item) => item.status === 'unpaid'),
  );
  const currentMoney: Record<MoneyField, string> = {
    onlineRevenue: draft.onlineRevenue,
    invoicedCashRevenue: draft.invoicedCashRevenue,
    operatingExpenses: operatingExpenseTotal.value,
    wagesPaid: paidWageTotal.value,
    wagesAccrued: unpaidWageTotal.value,
    nextPurchaseReserve: draft.nextPurchaseReserve,
    priorPurchaseAdjustment: draft.priorPurchaseAdjustment,
    cashOnHand: draft.cashOnHand,
  };
  // A total-only row was created before this product recorded individual
  // entries. It has no trustworthy row-level author, so it must remain an
  // immutable historical total instead of being retroactively attributed to
  // the person who happens to open the record today.
  const hasHistoricalOperatingExpenseTotal = draft.operatingExpenseItems.some(
    (item) => item.isHistorical,
  );
  const hasHistoricalWageTotal = draft.wageItems.some((item) => item.isHistorical);
  const invalidMoney = DIRECT_MONEY_FIELDS.some(
    (field) => isMoney(draft[field], field === 'priorPurchaseAdjustment') === false,
  );
  const operatingExpenseItemsChanged =
    !!existing &&
    !sameDetailItems(
      comparableOperatingExpenseItems(draft.operatingExpenseItems),
      comparableRecordOperatingExpenseItems(existing.operatingExpenseItems ?? []),
    );
  const wageItemsChanged =
    !!existing &&
    !sameDetailItems(
      comparableWageItems(draft.wageItems),
      comparableWageItems(existing.wageItems ?? []),
    );
  // Historical wage rows keep their name snapshot and may be viewed or left
  // untouched. The moment the wage section changes, every row must be tied to
  // a current store employee before it can be saved.
  const wageSelectionRequired = !existing || wageItemsChanged;
  const invalidDetails =
    !operatingExpenseTotal.valid ||
    !paidWageTotal.valid ||
    !unpaidWageTotal.valid ||
    draft.operatingExpenseItems.some((item) => !isValidOperatingExpense(item)) ||
    draft.wageItems.some((item) => !isValidWageItem(item, wageSelectionRequired));
  const hasChanges = useMemo(() => {
    if (!existing) return true;
    return (
      MONEY_FIELDS.some(
        (field) => normalizedMoney(currentMoney[field]) !== normalizedMoney(existing[field]),
      ) ||
      operatingExpenseItemsChanged ||
      wageItemsChanged ||
      draft.note.trim() !== (existing.note ?? '').trim()
    );
  }, [currentMoney, draft.note, existing, operatingExpenseItemsChanged, wageItemsChanged]);
  const hasUnsavedChanges =
    existing !== null
      ? hasChanges
      : DIRECT_MONEY_FIELDS.some((field) => normalizedMoney(draft[field]) !== '0.00') ||
        draft.note.trim().length > 0 ||
        draft.operatingExpenseItems.length > 0 ||
        draft.wageItems.length > 0;
  const confirmDiscard = () =>
    hasUnsavedChanges
      ? confirmSettlement(i18n.t('settlement.confirm.discard'))
      : Promise.resolve(true);
  const confirmDiscardChanges = (onConfirm: () => void) => {
    void confirmDiscard().then((confirmed) => {
      if (confirmed) onConfirm();
    });
  };
  // StoreChip is global chrome, so it cannot know whether this local form is
  // dirty. Register the same confirmation used by the page-local selector;
  // this prevents an org admin switching stores from silently losing a close.
  useEffect(
    () =>
      registerStoreChangeGuard((nextStoreId) => {
        if (nextStoreId === requestedStoreId || !hasUnsavedChanges) return true;
        return confirmSettlement(i18n.t('settlement.confirm.discard'));
      }),
    [hasUnsavedChanges, i18n, requestedStoreId],
  );
  // The shell only renders the active bottom-tab page, so leaving this tab
  // otherwise unmounts the form. Keep the same explicit confirmation used
  // for store/date changes before allowing that destructive transition.
  useEffect(
    () =>
      registerTabChangeGuard((nextTab) => {
        if (nextTab === 'settlement' || !hasUnsavedChanges) return true;
        return confirmSettlement(i18n.t('settlement.confirm.discard'));
      }),
    [hasUnsavedChanges, i18n],
  );
  // Browser refresh/close is the only way to leave a WebApp without going
  // through the shell controls. Browsers provide their own localized
  // confirmation here instead of a custom dialog.
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);
  const needsCorrectionReason = !!existing && hasChanges;
  const correctionReady = !needsCorrectionReason || draft.correctionReason.trim().length > 0;
  const dateValid = !!businessDate && BUSINESS_DATE.test(date) && date <= businessDate.date;
  const draftSynchronized = !closeQuery.isPending && draftRecordKey === recordKey;
  const canSave =
    !!currentStoreId &&
    draftSynchronized &&
    dateValid &&
    !invalidMoney &&
    !invalidDetails &&
    hasChanges &&
    correctionReady &&
    !versionConflict &&
    !closeQuery.isFetching &&
    !closeQuery.isError;
  const canRecordOperatingExpenses = businessDate?.canRecordOperatingExpenses ?? false;
  const canEditOperatingExpenses =
    canRecordOperatingExpenses && !hasHistoricalOperatingExpenseTotal;
  const wageRoster = (wageRosterQuery.data ?? []) as WageRosterMember[];
  const filteredWageRoster = useMemo(() => {
    const query = wageSearch.trim().toLocaleLowerCase();
    return wageRoster.filter((employee) => {
      if (wageRoleFilter && !employee.roles.some((role) => role.id === wageRoleFilter)) {
        return false;
      }
      return !query || employee.displayName.toLocaleLowerCase().includes(query);
    });
  }, [wageRoleFilter, wageRoster, wageSearch]);

  const onlineRevenue = moneyNumber(draft.onlineRevenue);
  const invoicedCashRevenue = moneyNumber(draft.invoicedCashRevenue);
  const operatingExpenses = moneyNumber(currentMoney.operatingExpenses);
  const wagesPaid = moneyNumber(currentMoney.wagesPaid);
  const wagesAccrued = moneyNumber(currentMoney.wagesAccrued);
  const nextPurchaseReserve = moneyNumber(draft.nextPurchaseReserve);
  const priorPurchaseAdjustment = moneyNumber(draft.priorPurchaseAdjustment);
  const cashOnHand = moneyNumber(draft.cashOnHand);
  const summary = {
    totalRevenue: onlineRevenue + invoicedCashRevenue,
    paidOutflows: operatingExpenses + wagesPaid,
    futureCommitments: wagesAccrued + nextPurchaseReserve,
    priorPurchaseAdjustment,
    endingCash: cashOnHand,
  };

  const saveMutation = trpc.settlement.save.useMutation({
    onSuccess: (saved) => {
      const savedRecord = saved as SettlementRecord;
      setDraft(draftFromRecord(savedRecord));
      setDraftRecordKey(
        `${savedRecord.storeId}:${savedRecord.date}:${savedRecord.id}:${savedRecord.version}`,
      );
      setVersionConflict(false);
      haptic('success');
      toast.success(i18n.t('settlement.saved'));
      void utils.settlement.get.invalidate({ storeId: saved.storeId, date: saved.date });
      void utils.settlement.recent.invalidate({ storeId: saved.storeId });
    },
    onError: (error) => {
      if (isVersionConflict(error)) {
        setVersionConflict(true);
        haptic('warning');
        return;
      }
      haptic('error');
      toast.error(i18n.t('settlement.errors.save'));
    },
  });

  const save = () => {
    if (!currentStoreId || !canSave || saveMutation.isPending) return;
    const operatingExpenseItems = draft.operatingExpenseItems.map((item) => ({
      ...(item.persistedId ? { id: item.persistedId } : {}),
      amount: item.amount.trim(),
      reason: item.reason.trim(),
    }));
    const wageItems = draft.wageItems.map((item) => ({
      ...(item.persistedId ? { id: item.persistedId } : {}),
      ...(item.memberId ? { memberId: item.memberId } : { personName: item.personName.trim() }),
      status: item.status,
      amount: item.amount.trim(),
      reason: item.reason.trim(),
    }));
    saveMutation.mutate({
      storeId: currentStoreId,
      date,
      onlineRevenue: draft.onlineRevenue.trim(),
      invoicedCashRevenue: draft.invoicedCashRevenue.trim(),
      // Detail rows are the source of truth; the scalars are sent only so
      // the API can reject a malformed/mismatched client rather than ever
      // saving a total that does not equal its explanation.
      operatingExpenses: currentMoney.operatingExpenses,
      wagesPaid: currentMoney.wagesPaid,
      wagesAccrued: currentMoney.wagesAccrued,
      // Preserve raw historical arrays when this section did not change. In
      // particular, a total-only old close must never be rewritten with a
      // display-only virtual detail row merely because revenue was corrected.
      ...(existing && !operatingExpenseItemsChanged ? {} : { operatingExpenseItems }),
      ...(existing && !wageItemsChanged ? {} : { wageItems }),
      nextPurchaseReserve: draft.nextPurchaseReserve.trim(),
      priorPurchaseAdjustment: draft.priorPurchaseAdjustment.trim(),
      cashOnHand: draft.cashOnHand.trim(),
      note: draft.note.trim() || null,
      correctionReason: needsCorrectionReason ? draft.correctionReason.trim() : null,
      expectedVersion: existing?.version ?? 0,
    });
  };

  const refreshRecord = () => {
    confirmDiscardChanges(() => {
      setVersionConflict(false);
      void closeQuery.refetch();
      void recentQuery.refetch();
    });
  };

  const mainButtonText = saveMutation.isPending
    ? i18n.t('settlement.save.saving')
    : existing
      ? i18n.t('settlement.save.update')
      : i18n.t('settlement.save.new');
  usePageMainButton(mainButtonText, save, {
    // What the day comes to, over the button that records it.
    summary: {
      text: i18n.t('settlement.summary.totalRevenue') as string,
      amount: formatMoney(summary.totalRevenue),
      currency,
    },
    visible:
      !!currentStoreId &&
      currentStoreId === requestedStoreId &&
      !!businessDate &&
      draftSynchronized,
    active: canSave && !saveMutation.isPending,
  });

  if (!session) return null;

  const heading = (
    <header className="flex items-start justify-between gap-lg">
      <h1 className="text-h1 text-ink">{i18n.t('settlement.title')}</h1>
      {existing ? (
        <StatusChip tone="pending">
          {i18n.t('settlement.recent.version', { version: existing.version })}
        </StatusChip>
      ) : null}
    </header>
  );
  const frame = (content: React.ReactNode) => (
    <div className="flex flex-col gap-xl px-page py-xl">
      {heading}
      {content}
    </div>
  );
  const waiting = <p className="text-body text-secondary">{i18n.t('common.loading')}</p>;

  if (storesQuery.isPending) return frame(waiting);
  if (storesQuery.isError) {
    return frame(
      <ErrorState
        title={i18n.t('settlement.errors.stores') as string}
        retryLabel={i18n.t('settlement.action.refresh') as string}
        onRetry={() => void storesQuery.refetch()}
      />,
    );
  }
  if (!currentStoreId) {
    return frame(
      <EmptyState
        title={i18n.t('settlement.noEligibleStores.title') as string}
        hint={i18n.t('settlement.noEligibleStores.body') as string}
        action={null}
      />,
    );
  }
  // Never one store's form under another store's name, not even for the
  // single paint before the two are brought back in line.
  if (currentStoreId !== requestedStoreId) return frame(waiting);
  if (!businessDate) {
    return frame(
      businessDateQuery.isError ? (
        <ErrorState
          title={i18n.t('settlement.errors.businessDate') as string}
          retryLabel={i18n.t('settlement.action.refresh') as string}
          onRetry={() => void businessDateQuery.refetch()}
        />
      ) : (
        waiting
      ),
    );
  }
  // A cached answer for another store or date can arrive first. Show
  // neither that nor an empty form while the right record is loading.
  if (!draftSynchronized) return frame(waiting);

  const setMoney = (field: (typeof DIRECT_MONEY_FIELDS)[number], value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const addOperatingExpense = () => {
    if (!canEditOperatingExpenses) {
      haptic('warning');
      toast.error(
        i18n.t(
          canRecordOperatingExpenses
            ? 'settlement.details.historicalReadOnly'
            : 'settlement.errors.expensesManagerOnly',
        ),
      );
      return;
    }
    if (draft.operatingExpenseItems.length >= MAX_DETAIL_ITEMS) {
      haptic('warning');
      toast.error(i18n.t('settlement.errors.detailLimit', { count: MAX_DETAIL_ITEMS }));
      return;
    }
    haptic('light');
    setDraft((current) => ({
      ...current,
      operatingExpenseItems: [
        ...current.operatingExpenseItems,
        {
          id: newDetailId(),
          persistedId: null,
          amount: '',
          reason: '',
          isHistorical: false,
        },
      ],
    }));
  };

  const updateOperatingExpense = (
    id: string,
    patch: Partial<Omit<OperatingExpenseDraft, 'id'>>,
  ) => {
    if (!canEditOperatingExpenses) return;
    setDraft((current) => ({
      ...current,
      operatingExpenseItems: current.operatingExpenseItems.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  };

  const removeOperatingExpense = (id: string) => {
    if (!canEditOperatingExpenses) return;
    const remove = () => {
      haptic('light');
      setDraft((current) => ({
        ...current,
        operatingExpenseItems: current.operatingExpenseItems.filter((item) => item.id !== id),
      }));
    };
    if (existing) {
      confirmSettlementAction(i18n.t('settlement.confirm.removeDetail'), remove);
    } else {
      remove();
    }
  };

  const addWageItem = () => {
    if (hasHistoricalWageTotal) {
      haptic('warning');
      toast.error(i18n.t('settlement.details.historicalReadOnly'));
      return;
    }
    if (draft.wageItems.length >= MAX_DETAIL_ITEMS) {
      haptic('warning');
      toast.error(i18n.t('settlement.errors.detailLimit', { count: MAX_DETAIL_ITEMS }));
      return;
    }
    const id = newDetailId();
    haptic('light');
    setDraft((current) => ({
      ...current,
      wageItems: [
        ...current.wageItems,
        {
          id,
          persistedId: null,
          memberId: null,
          personName: '',
          status: 'paid',
          amount: '',
          reason: '',
          isHistorical: false,
        },
      ],
    }));
    setWageRoleFilter('');
    setWageSearch('');
    setNewWagePickerFor(id);
    setWagePickerFor(id);
  };

  const updateWageItem = (id: string, patch: Partial<Omit<WageItemDraft, 'id'>>) => {
    setDraft((current) => ({
      ...current,
      wageItems: current.wageItems.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  };

  const removeWageItem = (id: string) => {
    if (hasHistoricalWageTotal) return;
    const remove = () => {
      haptic('light');
      setDraft((current) => ({
        ...current,
        wageItems: current.wageItems.filter((item) => item.id !== id),
      }));
    };
    if (existing) {
      confirmSettlementAction(i18n.t('settlement.confirm.removeDetail'), remove);
    } else {
      remove();
    }
  };

  const selectWageEmployee = (employee: WageRosterMember) => {
    if (!wagePickerFor) return;
    updateWageItem(wagePickerFor, {
      memberId: employee.memberId,
      personName: employee.displayName,
      isHistorical: false,
    });
    haptic('light');
    setWagePickerFor(null);
    setNewWagePickerFor(null);
    setWageRoleFilter('');
    setWageSearch('');
  };

  const closeWagePicker = () => {
    const abandonedNewWageId = newWagePickerFor === wagePickerFor ? wagePickerFor : null;
    if (abandonedNewWageId) {
      setDraft((current) => ({
        ...current,
        wageItems: current.wageItems.filter((item) => item.id !== abandonedNewWageId),
      }));
    }
    setWagePickerFor(null);
    setNewWagePickerFor(null);
    setWageRoleFilter('');
    setWageSearch('');
  };

  const NEWEST = '__newest__';
  const openExpense =
    editExpense === NEWEST
      ? draft.operatingExpenseItems[draft.operatingExpenseItems.length - 1]
      : draft.operatingExpenseItems.find((item) => item.id === editExpense);
  const openWage = draft.wageItems.find((item) => item.id === editWage);

  const moneyField = (field: (typeof DIRECT_MONEY_FIELDS)[number], labelKey: string) => (
    <Field
      numeric
      label={i18n.t(labelKey as Parameters<typeof i18n.t>[0]) as string}
      value={draft[field]}
      placeholder="0"
      onChange={(event) => setMoney(field, event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      suffix={currency}
    />
  );

  // A line opened and left blank was a slip, not an entry.
  const closeExpense = () => {
    const item = openExpense;
    setEditExpense(null);
    if (item && !item.amount.trim() && !item.reason.trim()) {
      setDraft((current) => ({
        ...current,
        operatingExpenseItems: current.operatingExpenseItems.filter((e) => e.id !== item.id),
      }));
    }
  };
  const wageName = (wage: WageItemDraft): string =>
    wage.isHistorical
      ? (i18n.t('settlement.wages.historicalEmployee') as string)
      : wage.personName || (i18n.t('settlement.wages.chooseEmployee') as string);
  const wageStatus = (status: WageItemDraft['status']): string =>
    i18n.t(
      status === 'paid' ? 'settlement.wages.status.paid' : 'settlement.wages.status.unpaid',
    ) as string;
  const amountOf = (value: string) =>
    (moneyToCents(value) ?? 0n) > 0n ? <Money amount={formatMoney(value)} /> : undefined;
  const pickerQuery = wageSearch.trim().toLocaleLowerCase();
  const pickable = filteredWageRoster.filter(
    (employee) =>
      !pickerQuery ||
      employee.displayName.toLocaleLowerCase().includes(pickerQuery) ||
      employee.roles.some((role) => role.name.toLocaleLowerCase().includes(pickerQuery)),
  );

  return frame(
    <>
      <Field
        type="date"
        label={i18n.t('settlement.date.label') as string}
        value={date}
        max={businessDate.date}
        onChange={(event) => {
          const nextDate = event.target.value;
          if (nextDate === date) return;
          confirmDiscardChanges(() => setDate(nextDate));
        }}
      />

      {closeQuery.isError ? (
        <ErrorState
          title={i18n.t('settlement.errors.save') as string}
          retryLabel={i18n.t('settlement.action.refresh') as string}
          onRetry={refreshRecord}
        />
      ) : null}
      {/* Someone else saved this day in the meantime. Their version has to
          be loaded before anything can be saved over it. */}
      {versionConflict ? (
        <ErrorState
          title={i18n.t('settlement.errors.versionConflict') as string}
          detail={i18n.t('settlement.errors.versionConflictBody') as string}
          retryLabel={i18n.t('settlement.action.refresh') as string}
          onRetry={refreshRecord}
        />
      ) : null}

      <Section title={i18n.t('settlement.group.revenue') as string}>
        {moneyField('invoicedCashRevenue', 'settlement.field.invoicedCashRevenue')}
        {moneyField('onlineRevenue', 'settlement.field.onlineRevenue')}
      </Section>

      <Section
        title={i18n.t('settlement.field.operatingExpenses') as string}
        summary={<Money amount={formatMoney(operatingExpenseTotal.value)} currency={currency} />}
      >
        {hasHistoricalOperatingExpenseTotal ? (
          <p className="text-body text-secondary">
            {i18n.t('settlement.details.historicalReadOnlyBody')}
          </p>
        ) : !canRecordOperatingExpenses ? (
          <p className="text-body text-secondary">{i18n.t('settlement.expenses.readOnly')}</p>
        ) : null}
        <List>
          {draft.operatingExpenseItems.map((expense) => (
            <Row
              key={expense.id}
              data-testid="close-expense"
              title={
                expense.isHistorical
                  ? i18n.t('settlement.expenses.historicalReason')
                  : expense.reason.trim() || i18n.t('settlement.expenses.reason')
              }
              value={amountOf(expense.amount)}
              onPress={
                canEditOperatingExpenses && !expense.isHistorical
                  ? () => setEditExpense(expense.id)
                  : undefined
              }
            />
          ))}
          {canEditOperatingExpenses && draft.operatingExpenseItems.length < MAX_DETAIL_ITEMS ? (
            <Row
              action
              data-testid="close-add-expense"
              title={i18n.t('settlement.expenses.add')}
              onPress={() => {
                addOperatingExpense();
                setEditExpense(NEWEST);
              }}
            />
          ) : null}
        </List>
      </Section>

      <Section
        title={i18n.t('settlement.wages.title') as string}
        summary={
          <span className="text-body text-secondary">
            {i18n.t('settlement.wages.totals', {
              paid: formatMoney(paidWageTotal.value, currency),
              unpaid: formatMoney(unpaidWageTotal.value, currency),
            })}
          </span>
        }
      >
        {hasHistoricalWageTotal ? (
          <p className="text-body text-secondary">
            {i18n.t('settlement.details.historicalReadOnlyBody')}
          </p>
        ) : null}
        <List>
          {draft.wageItems.map((wage) => (
            <Row
              key={wage.id}
              data-testid="close-wage"
              title={wageName(wage)}
              detail={[wageStatus(wage.status), wage.isHistorical ? null : wage.reason.trim()]
                .filter(Boolean)
                .join(' · ')}
              value={amountOf(wage.amount)}
              onPress={wage.isHistorical ? undefined : () => setEditWage(wage.id)}
            />
          ))}
          {!hasHistoricalWageTotal && draft.wageItems.length < MAX_DETAIL_ITEMS ? (
            <Row
              action
              data-testid="close-add-wage"
              title={i18n.t('settlement.wages.add')}
              onPress={addWageItem}
            />
          ) : null}
        </List>
      </Section>

      <Section title={i18n.t('settlement.group.procurement') as string}>
        {moneyField('nextPurchaseReserve', 'settlement.field.nextPurchaseReserve')}
        {moneyField('priorPurchaseAdjustment', 'settlement.field.priorPurchaseAdjustment')}
        {/* The one field that may be negative; say which way is which. */}
        <p className="text-body text-secondary">
          {i18n.t('settlement.purchaseAdjustment.positive')}{' '}
          {i18n.t('settlement.purchaseAdjustment.negative')}
        </p>
      </Section>

      <Section title={i18n.t('settlement.group.cash') as string}>
        {moneyField('cashOnHand', 'settlement.field.cashOnHand')}
      </Section>

      <Section>
        <Field
          label={i18n.t('settlement.field.note') as string}
          value={draft.note}
          maxLength={1000}
          placeholder={i18n.t('settlement.note.placeholder') as string}
          onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
        />
        {/* A saved close is a record; changing it has to say why. */}
        {needsCorrectionReason ? (
          <Field
            label={i18n.t('settlement.field.correctionReason') as string}
            value={draft.correctionReason}
            maxLength={500}
            placeholder={i18n.t('settlement.correction.placeholder') as string}
            onChange={(event) =>
              setDraft((current) => ({ ...current, correctionReason: event.target.value }))
            }
          />
        ) : null}
        {invalidMoney ? (
          <p role="alert" className="text-body text-warning-ink">
            {i18n.t('settlement.errors.invalidMoney')}
          </p>
        ) : null}
        {invalidDetails ? (
          <p role="alert" className="text-body text-warning-ink">
            {i18n.t('settlement.errors.invalidDetailsBody')}
          </p>
        ) : null}
      </Section>

      <Section title={i18n.t('settlement.summary.title') as string}>
        <List>
          <Row
            title={i18n.t('settlement.summary.totalRevenue')}
            value={<Money amount={formatMoney(summary.totalRevenue)} currency={currency} />}
          />
          <Row
            title={i18n.t('settlement.summary.paidOutflows')}
            value={<Money amount={formatMoney(summary.paidOutflows)} currency={currency} />}
          />
          <Row
            title={i18n.t('settlement.summary.futureCommitments')}
            value={<Money amount={formatMoney(summary.futureCommitments)} currency={currency} />}
          />
          <Row
            title={i18n.t('settlement.summary.priorPurchaseAdjustment')}
            value={<Money amount={formatSignedMoney(summary.priorPurchaseAdjustment, currency)} />}
          />
          <Row
            title={i18n.t('settlement.summary.endingCash')}
            value={<Money amount={formatMoney(summary.endingCash)} currency={currency} />}
          />
        </List>
      </Section>

      {recentQuery.data?.length ? (
        <Section title={i18n.t('settlement.recent.title') as string}>
          <List>
            {recentQuery.data.map((record) => (
              <Row
                key={record.id}
                data-testid="close-recent"
                title={record.date}
                detail={[
                  i18n.t('settlement.recent.version', { version: record.version }),
                  record.updatedByName
                    ? i18n.t('settlement.recent.updatedBy', { name: record.updatedByName })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onPress={
                  record.date === date
                    ? undefined
                    : () => confirmDiscardChanges(() => setDate(record.date))
                }
              />
            ))}
          </List>
        </Section>
      ) : null}

      {openExpense ? (
        <Sheet
          open
          onOpenChange={(open) => !open && closeExpense()}
          title={i18n.t('settlement.field.operatingExpenses') as string}
          actions={
            <>
              <Button variant="primary" data-testid="close-expense-done" onClick={closeExpense}>
                {i18n.t('common.done')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditExpense(null);
                  removeOperatingExpense(openExpense.id);
                }}
              >
                <span className="text-danger">{i18n.t('settlement.expenses.remove')}</span>
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-lg">
            <Field
              numeric
              label={i18n.t('settlement.expenses.amount') as string}
              value={openExpense.amount}
              placeholder="0"
              onChange={(event) =>
                updateOperatingExpense(openExpense.id, {
                  amount: event.target.value,
                  isHistorical: false,
                })
              }
              suffix={currency}
            />
            <Field
              label={i18n.t('settlement.expenses.reason') as string}
              value={openExpense.reason}
              maxLength={500}
              onChange={(event) =>
                updateOperatingExpense(openExpense.id, {
                  reason: event.target.value,
                  isHistorical: false,
                })
              }
            />
          </div>
        </Sheet>
      ) : null}

      {openWage && !wagePickerFor ? (
        <Sheet
          open
          onOpenChange={(open) => !open && setEditWage(null)}
          title={wageName(openWage)}
          keepFocus
          actions={
            <>
              <Button
                variant="primary"
                data-testid="close-wage-done"
                onClick={() => setEditWage(null)}
              >
                {i18n.t('common.done')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditWage(null);
                  removeWageItem(openWage.id);
                }}
              >
                <span className="text-danger">{i18n.t('settlement.wages.remove')}</span>
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-lg">
            <List>
              <Row
                title={i18n.t('settlement.wages.employee')}
                detail={
                  !openWage.memberId && openWage.personName
                    ? i18n.t('settlement.wages.legacyEmployee')
                    : wageName(openWage)
                }
                onPress={() => {
                  setWagePickerFor(openWage.id);
                  setNewWagePickerFor(null);
                  setWageSearch('');
                }}
              />
            </List>
            <ChoiceGroup<WageItemDraft['status']>
              label={i18n.t('settlement.wages.status') as string}
              value={openWage.status}
              onChange={(status) => updateWageItem(openWage.id, { status, isHistorical: false })}
              options={[
                { value: 'paid', label: wageStatus('paid') },
                { value: 'unpaid', label: wageStatus('unpaid') },
              ]}
            />
            <Field
              numeric
              label={i18n.t('settlement.wages.amount') as string}
              value={openWage.amount}
              placeholder="0"
              onChange={(event) =>
                updateWageItem(openWage.id, { amount: event.target.value, isHistorical: false })
              }
              suffix={currency}
            />
            <Field
              label={i18n.t('settlement.wages.reason') as string}
              value={openWage.reason}
              maxLength={500}
              onChange={(event) =>
                updateWageItem(openWage.id, { reason: event.target.value, isHistorical: false })
              }
            />
          </div>
        </Sheet>
      ) : null}

      {wagePickerFor ? (
        <Sheet
          open
          onOpenChange={(open) => !open && closeWagePicker()}
          title={i18n.t('settlement.wages.pickerTitle') as string}
        >
          <div className="flex flex-col gap-lg">
            <Field
              type="search"
              label={i18n.t('settlement.wages.searchEmployees') as string}
              value={wageSearch}
              onChange={(event) => setWageSearch(event.target.value)}
            />
            {wageRosterQuery.isPending ? waiting : null}
            {wageRosterQuery.isError ? (
              <ErrorState
                title={i18n.t('settlement.wages.rosterError') as string}
                retryLabel={i18n.t('settlement.action.refresh') as string}
                onRetry={() => void wageRosterQuery.refetch()}
              />
            ) : null}
            {!wageRosterQuery.isPending && !wageRosterQuery.isError && wageRoster.length === 0 ? (
              <EmptyState
                title={i18n.t('settlement.wages.rosterEmptyTitle') as string}
                hint={i18n.t('settlement.wages.rosterEmptyBody') as string}
                action={null}
              />
            ) : null}
            {wageRoster.length > 0 && pickable.length === 0 ? (
              <p className="text-body text-secondary">
                {i18n.t('settlement.wages.noEmployeeMatch')}
              </p>
            ) : null}
            {pickable.length > 0 ? (
              <List>
                {pickable.map((employee) => (
                  <Row
                    key={employee.memberId}
                    picks
                    data-testid="close-employee"
                    title={employee.displayName}
                    detail={
                      employee.roles.length > 0
                        ? employee.roles.map((role) => role.name).join(' · ')
                        : i18n.t('settlement.wages.noRole')
                    }
                    onPress={() => {
                      const id = wagePickerFor;
                      selectWageEmployee(employee);
                      // Straight on to the amount: the person was the first
                      // question, not the whole entry.
                      setEditWage(id);
                    }}
                  />
                ))}
              </List>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </>,
  );
}
