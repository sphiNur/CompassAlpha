/**
 * SettlementPage — one store's end-of-day cash close.
 *
 * A daily close is deliberately a small, explicit record rather than a
 * calculated sales report: the cashier records what happened and the API
 * keeps a versioned correction trail.  This screen therefore never infers
 * cash from other modules or silently overwrites an existing close.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardMeta,
  CardTitle,
  EmptyState,
  Field,
  Input,
  NumberInput,
  SearchInput,
  SectionLabel,
  Select,
  Sheet,
  Spinner,
  Textarea,
  useToast,
} from '@compass/ui';
import type { SettlementWageItem } from '@compass/contracts';
import { trpc } from '../lib/trpc';
import { registerStoreChangeGuard, useStoreContext } from '../components/StoreSwitcher';
import { usePageMainButton, getTg, haptic } from '../hooks/useTelegram';
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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-body-sm">
      <span className="text-[var(--c-fg-muted)]">{label}</span>
      <strong className="shrink-0 tabular-nums text-[var(--c-fg)]">{value}</strong>
    </div>
  );
}

function formatSignedMoney(value: number, currency: string): string {
  const formatted = formatMoney(Math.abs(value), currency);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

function AmountField({
  label,
  value,
  signed = false,
  onChange,
}: {
  label: string;
  value: string;
  signed?: boolean;
  onChange: (value: string) => void;
}) {
  const valid = isMoney(value, signed);
  return (
    <Field label={label}>
      <NumberInput
        value={value}
        min={signed ? '-999999999999.99' : '0'}
        max="999999999999.99"
        step="0.01"
        placeholder="0"
        aria-label={label}
        aria-invalid={!valid || undefined}
        className={!valid ? 'border-[var(--c-danger)]' : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** Use Telegram's native confirmation sheet when available, with web fallback. */
function confirmSettlement(message: string): Promise<boolean> {
  const tg = getTg();
  if (tg) {
    return new Promise((resolve) => {
      tg.showConfirm(message.replace(/\s*\n\s*/g, ' '), resolve);
    });
  }
  return Promise.resolve(confirm(message));
}

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
  const wageRoleOptions = useMemo(() => {
    const byId = new Map<string, WageRosterMember['roles'][number]>();
    for (const employee of wageRoster) {
      for (const role of employee.roles) byId.set(role.id, role);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [wageRoster]);
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
    visible:
      !!currentStoreId &&
      currentStoreId === requestedStoreId &&
      !!businessDate &&
      draftSynchronized,
    active: canSave && !saveMutation.isPending,
  });

  if (!session) return null;

  const pageHeading = (
    <div>
      <h1 className="text-h1 font-semibold text-[var(--c-fg)]">{i18n.t('settlement.title')}</h1>
      <p className="mt-1 text-body-sm text-[var(--c-fg-muted)]">{i18n.t('settlement.subtitle')}</p>
    </div>
  );
  const storeSelector =
    eligibleStores.length > 1 && currentStoreId ? (
      <Field label={i18n.t('settlement.store.label')}>
        <Select
          value={currentStoreId}
          aria-label={i18n.t('settlement.store.label')}
          onChange={(event) => {
            const nextStoreId = event.target.value;
            if (nextStoreId === currentStoreId) return;
            confirmDiscardChanges(() => setCurrentStore(nextStoreId));
          }}
        >
          {eligibleStores.map((store) => (
            <option key={store.id} value={store.id}>
              {store.name}
            </option>
          ))}
        </Select>
      </Field>
    ) : null;

  if (storesQuery.isPending) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        <div className="flex justify-center py-8">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  if (storesQuery.isError) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        <Banner
          tone="danger"
          title={i18n.t('settlement.errors.stores')}
          action={
            <Button size="sm" variant="pearl" onClick={() => void storesQuery.refetch()}>
              {i18n.t('settlement.action.refresh')}
            </Button>
          }
        />
      </div>
    );
  }

  if (!currentStoreId) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        <EmptyState
          title={i18n.t('settlement.noEligibleStores.title')}
          description={i18n.t('settlement.noEligibleStores.body')}
        />
      </div>
    );
  }

  // Do not render Store A's form under Store B's shell label even for the
  // single paint before the synchronization effect updates global context.
  if (currentStoreId !== requestedStoreId) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        <div className="flex justify-center py-8">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  if (!businessDate) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        {storeSelector}
        {businessDateQuery.isError ? (
          <Banner
            tone="danger"
            title={i18n.t('settlement.errors.businessDate')}
            action={
              <Button size="sm" variant="pearl" onClick={() => void businessDateQuery.refetch()}>
                {i18n.t('settlement.action.refresh')}
              </Button>
            }
          />
        ) : (
          <div className="flex justify-center py-8">
            <Spinner size={20} />
          </div>
        )}
      </div>
    );
  }

  // Query caches can resolve a different store/date before the draft-reset
  // effect runs. Do not briefly render any prior form under this context, and
  // do not offer an empty form while the selected close is still loading.
  if (!draftSynchronized) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        {storeSelector}
        <div className="flex justify-center py-8" aria-label={i18n.t('settlement.title')}>
          <Spinner size={20} />
        </div>
      </div>
    );
  }

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

  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex flex-col gap-3 px-4 pt-3">
        {pageHeading}
        {storeSelector}

        <Field
          label={i18n.t('settlement.date.label')}
          hint={i18n.t('settlement.date.timezone', { timezone: businessDate.timezone })}
        >
          <Input
            type="date"
            value={date}
            max={businessDate.date}
            aria-label={i18n.t('settlement.date.label')}
            invalid={!dateValid}
            onChange={(event) => {
              const nextDate = event.target.value;
              if (nextDate === date) return;
              confirmDiscardChanges(() => setDate(nextDate));
            }}
          />
        </Field>

        {closeQuery.isPending ? (
          <div className="flex justify-center py-4" aria-label={i18n.t('settlement.title')}>
            <Spinner size={20} />
          </div>
        ) : null}

        {closeQuery.isError ? (
          <Banner
            tone="danger"
            title={i18n.t('settlement.errors.save')}
            action={
              <Button size="sm" variant="pearl" onClick={refreshRecord}>
                {i18n.t('settlement.action.refresh')}
              </Button>
            }
          />
        ) : null}

        {versionConflict ? (
          <Banner
            tone="warn"
            title={i18n.t('settlement.errors.versionConflict')}
            action={
              <Button size="sm" variant="pearl" onClick={refreshRecord}>
                {i18n.t('settlement.action.refresh')}
              </Button>
            }
          >
            {i18n.t('settlement.errors.versionConflictBody')}
          </Banner>
        ) : null}

        {existing ? (
          <Banner tone="info" title={i18n.t('settlement.editing.title')}>
            {i18n.t('settlement.editing.body')}
          </Banner>
        ) : null}

        <section className="flex flex-col gap-2">
          <SectionLabel as="h2">{i18n.t('settlement.group.revenue')}</SectionLabel>
          <Card>
            <CardBody className="flex flex-col gap-3">
              <CardMeta>{i18n.t('settlement.field.amountHint')}</CardMeta>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <AmountField
                  label={i18n.t('settlement.field.onlineRevenue')}
                  value={draft.onlineRevenue}
                  onChange={(value) => setMoney('onlineRevenue', value)}
                />
                <AmountField
                  label={i18n.t('settlement.field.invoicedCashRevenue')}
                  value={draft.invoicedCashRevenue}
                  onChange={(value) => setMoney('invoicedCashRevenue', value)}
                />
              </div>
            </CardBody>
          </Card>
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel as="h2">{i18n.t('settlement.group.costs')}</SectionLabel>
          <Card>
            <CardBody className="flex flex-col gap-5">
              <Banner tone="info" title={i18n.t('settlement.costs.autoTotalTitle')}>
                {i18n.t('settlement.costs.autoTotalHint')}
              </Banner>

              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-h3 font-semibold text-[var(--c-fg)]">
                      {i18n.t('settlement.expenses.title')}
                    </h3>
                    <p className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                      {i18n.t('settlement.expenses.total', {
                        money: formatMoney(operatingExpenseTotal.value, currency),
                      })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      !canEditOperatingExpenses ||
                      draft.operatingExpenseItems.length >= MAX_DETAIL_ITEMS
                    }
                    onClick={addOperatingExpense}
                  >
                    {i18n.t('settlement.expenses.add')}
                  </Button>
                </div>

                {hasHistoricalOperatingExpenseTotal ? (
                  <Banner tone="info" title={i18n.t('settlement.details.historicalReadOnly')}>
                    {i18n.t('settlement.details.historicalReadOnlyBody')}
                  </Banner>
                ) : !canRecordOperatingExpenses ? (
                  <Banner tone="info" title={i18n.t('settlement.errors.expensesManagerOnly')}>
                    {i18n.t('settlement.expenses.readOnly')}
                  </Banner>
                ) : null}

                {draft.operatingExpenseItems.length === 0 ? (
                  <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2 text-body-sm text-[var(--c-fg-muted)]">
                    {i18n.t('settlement.expenses.empty')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {draft.operatingExpenseItems.map((expense, index) => {
                      const valid = isValidOperatingExpense(expense);
                      return (
                        <div
                          key={expense.id}
                          className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] p-3 ring-hairline"
                        >
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <span className="text-label font-semibold text-[var(--c-fg-muted)]">
                              {i18n.t('settlement.expenses.itemNumber', { n: index + 1 })}
                            </span>
                            {canEditOperatingExpenses ? (
                              <Button
                                size="sm"
                                variant="danger-ghost"
                                aria-label={i18n.t('settlement.expenses.remove')}
                                onClick={() => removeOperatingExpense(expense.id)}
                              >
                                {i18n.t('settlement.expenses.remove')}
                              </Button>
                            ) : null}
                          </div>
                          <Field label={i18n.t('settlement.expenses.amount')}>
                            <NumberInput
                              value={expense.amount}
                              min="0.01"
                              max="999999999999.99"
                              step="0.01"
                              placeholder="0"
                              readOnly={!canEditOperatingExpenses}
                              aria-invalid={(moneyToCents(expense.amount) ?? 0n) <= 0n || undefined}
                              className={
                                (moneyToCents(expense.amount) ?? 0n) <= 0n
                                  ? 'border-[var(--c-danger)]'
                                  : undefined
                              }
                              onChange={(event) =>
                                updateOperatingExpense(expense.id, {
                                  amount: event.currentTarget.value,
                                  isHistorical: false,
                                })
                              }
                            />
                          </Field>
                          <div className="mt-3">
                            <Field label={i18n.t('settlement.expenses.reason')}>
                              {expense.isHistorical ? (
                                <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-3)] px-3 py-2 text-body-sm text-[var(--c-fg-muted)]">
                                  {i18n.t('settlement.expenses.historicalReason')}
                                </p>
                              ) : (
                                <Textarea
                                  value={expense.reason}
                                  maxLength={500}
                                  readOnly={!canEditOperatingExpenses}
                                  invalid={!valid && expense.reason.trim().length === 0}
                                  onChange={(event) =>
                                    updateOperatingExpense(expense.id, {
                                      reason: event.currentTarget.value,
                                      isHistorical: false,
                                    })
                                  }
                                />
                              )}
                            </Field>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--c-divider)]" />

              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-h3 font-semibold text-[var(--c-fg)]">
                      {i18n.t('settlement.wages.title')}
                    </h3>
                    <p className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                      {i18n.t('settlement.wages.totals', {
                        paid: formatMoney(paidWageTotal.value, currency),
                        unpaid: formatMoney(unpaidWageTotal.value, currency),
                      })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasHistoricalWageTotal || draft.wageItems.length >= MAX_DETAIL_ITEMS}
                    onClick={addWageItem}
                  >
                    {i18n.t('settlement.wages.add')}
                  </Button>
                </div>

                {hasHistoricalWageTotal ? (
                  <Banner tone="info" title={i18n.t('settlement.details.historicalReadOnly')}>
                    {i18n.t('settlement.details.historicalReadOnlyBody')}
                  </Banner>
                ) : null}

                {draft.wageItems.length === 0 ? (
                  <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2 text-body-sm text-[var(--c-fg-muted)]">
                    {i18n.t('settlement.wages.empty')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {draft.wageItems.map((wage, index) => {
                      const valid = isValidWageItem(wage, wageSelectionRequired);
                      const displayedEmployee = wage.isHistorical
                        ? i18n.t('settlement.wages.historicalEmployee')
                        : wage.personName || i18n.t('settlement.wages.chooseEmployee');
                      return (
                        <div
                          key={wage.id}
                          className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] p-3 ring-hairline"
                        >
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <span className="text-label font-semibold text-[var(--c-fg-muted)]">
                              {i18n.t('settlement.wages.itemNumber', { n: index + 1 })}
                            </span>
                            {!wage.isHistorical ? (
                              <Button
                                size="sm"
                                variant="danger-ghost"
                                aria-label={i18n.t('settlement.wages.remove')}
                                onClick={() => removeWageItem(wage.id)}
                              >
                                {i18n.t('settlement.wages.remove')}
                              </Button>
                            ) : null}
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field label={i18n.t('settlement.wages.employee')}>
                              <Button
                                type="button"
                                variant="secondary"
                                className="w-full justify-between text-left"
                                aria-invalid={
                                  (wageSelectionRequired && !wage.memberId) || undefined
                                }
                                disabled={wage.isHistorical}
                                onClick={() => {
                                  setWagePickerFor(wage.id);
                                  setNewWagePickerFor(null);
                                  setWageRoleFilter('');
                                  setWageSearch('');
                                }}
                              >
                                <span className="min-w-0 truncate">{displayedEmployee}</span>
                                <span aria-hidden>›</span>
                              </Button>
                              {!wage.memberId && wage.personName ? (
                                <p className="mt-1 text-label text-[var(--c-fg-muted)]">
                                  {i18n.t('settlement.wages.legacyEmployee')}
                                </p>
                              ) : null}
                            </Field>
                            <Field label={i18n.t('settlement.wages.status')}>
                              <Select
                                value={wage.status}
                                disabled={wage.isHistorical}
                                onChange={(event) =>
                                  updateWageItem(wage.id, {
                                    status: event.currentTarget.value as WageItemDraft['status'],
                                    isHistorical: false,
                                  })
                                }
                              >
                                <option value="paid">
                                  {i18n.t('settlement.wages.status.paid')}
                                </option>
                                <option value="unpaid">
                                  {i18n.t('settlement.wages.status.unpaid')}
                                </option>
                              </Select>
                            </Field>
                            <Field label={i18n.t('settlement.wages.amount')}>
                              <NumberInput
                                value={wage.amount}
                                min="0.01"
                                max="999999999999.99"
                                step="0.01"
                                placeholder="0"
                                readOnly={wage.isHistorical}
                                aria-invalid={(moneyToCents(wage.amount) ?? 0n) <= 0n || undefined}
                                className={
                                  (moneyToCents(wage.amount) ?? 0n) <= 0n
                                    ? 'border-[var(--c-danger)]'
                                    : undefined
                                }
                                onChange={(event) =>
                                  updateWageItem(wage.id, {
                                    amount: event.currentTarget.value,
                                    isHistorical: false,
                                  })
                                }
                              />
                            </Field>
                          </div>
                          <div className="mt-3">
                            <Field label={i18n.t('settlement.wages.reason')}>
                              {wage.isHistorical ? (
                                <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-3)] px-3 py-2 text-body-sm text-[var(--c-fg-muted)]">
                                  {i18n.t('settlement.wages.historicalReason')}
                                </p>
                              ) : (
                                <Textarea
                                  value={wage.reason}
                                  maxLength={500}
                                  invalid={!valid && wage.reason.trim().length === 0}
                                  onChange={(event) =>
                                    updateWageItem(wage.id, {
                                      reason: event.currentTarget.value,
                                      isHistorical: false,
                                    })
                                  }
                                />
                              )}
                            </Field>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </CardBody>
          </Card>
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel as="h2">{i18n.t('settlement.group.procurement')}</SectionLabel>
          <Card>
            <CardBody className="flex flex-col gap-3">
              <AmountField
                label={i18n.t('settlement.field.nextPurchaseReserve')}
                value={draft.nextPurchaseReserve}
                onChange={(value) => setMoney('nextPurchaseReserve', value)}
              />
              <AmountField
                label={i18n.t('settlement.field.priorPurchaseAdjustment')}
                value={draft.priorPurchaseAdjustment}
                signed
                onChange={(value) => setMoney('priorPurchaseAdjustment', value)}
              />
              <Banner tone="info" title={i18n.t('settlement.purchaseAdjustment.positive')}>
                {i18n.t('settlement.purchaseAdjustment.help')}
                <span className="mt-1 block">
                  {i18n.t('settlement.purchaseAdjustment.negative')}
                </span>
              </Banner>
            </CardBody>
          </Card>
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel as="h2">{i18n.t('settlement.group.cash')}</SectionLabel>
          <Card>
            <CardBody>
              <AmountField
                label={i18n.t('settlement.field.cashOnHand')}
                value={draft.cashOnHand}
                onChange={(value) => setMoney('cashOnHand', value)}
              />
            </CardBody>
          </Card>
        </section>

        <Card>
          <CardBody className="flex flex-col gap-3">
            <Field label={i18n.t('settlement.field.note')}>
              <Textarea
                value={draft.note}
                maxLength={1000}
                placeholder={i18n.t('settlement.note.placeholder')}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, note: event.target.value }))
                }
              />
            </Field>
            {needsCorrectionReason ? (
              <Field
                label={i18n.t('settlement.field.correctionReason')}
                hint={i18n.t('settlement.correction.required')}
              >
                <Textarea
                  value={draft.correctionReason}
                  maxLength={500}
                  invalid={!correctionReady}
                  placeholder={i18n.t('settlement.correction.placeholder')}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, correctionReason: event.target.value }))
                  }
                />
              </Field>
            ) : null}
          </CardBody>
        </Card>

        {invalidMoney ? (
          <Banner tone="warn" title={i18n.t('settlement.errors.invalidMoney')} />
        ) : null}
        {invalidDetails ? (
          <Banner tone="warn" title={i18n.t('settlement.errors.invalidDetails')}>
            {i18n.t('settlement.errors.invalidDetailsBody')}
          </Banner>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{i18n.t('settlement.summary.title')}</CardTitle>
          </CardHeader>
          <CardBody>
            <SummaryRow
              label={i18n.t('settlement.summary.totalRevenue')}
              value={formatMoney(summary.totalRevenue, currency)}
            />
            <SummaryRow
              label={i18n.t('settlement.summary.paidOutflows')}
              value={formatMoney(summary.paidOutflows, currency)}
            />
            <SummaryRow
              label={i18n.t('settlement.summary.futureCommitments')}
              value={formatMoney(summary.futureCommitments, currency)}
            />
            <SummaryRow
              label={i18n.t('settlement.summary.priorPurchaseAdjustment')}
              value={formatSignedMoney(summary.priorPurchaseAdjustment, currency)}
            />
            <SummaryRow
              label={i18n.t('settlement.summary.endingCash')}
              value={formatMoney(summary.endingCash, currency)}
            />
          </CardBody>
        </Card>

        <section className="flex flex-col gap-2">
          <SectionLabel as="h2">{i18n.t('settlement.recent.title')}</SectionLabel>
          {recentQuery.isPending ? (
            <div className="flex justify-center py-3">
              <Spinner size={18} />
            </div>
          ) : recentQuery.data?.length ? (
            <ul className="flex flex-col gap-2" role="list">
              {recentQuery.data.map((record) => (
                <li key={record.id}>
                  <Card interactive>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                      onClick={() => {
                        if (record.date === date) return;
                        confirmDiscardChanges(() => {
                          haptic('light');
                          setDate(record.date);
                        });
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block text-h3 font-semibold tabular-nums text-[var(--c-fg)]">
                          {record.date}
                        </span>
                        <span className="mt-0.5 block text-body-sm text-[var(--c-fg-muted)]">
                          {i18n.t('settlement.recent.version', { version: record.version })}
                          {record.updatedByName
                            ? ` · ${i18n.t('settlement.recent.updatedBy', { name: record.updatedByName })}`
                            : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-label font-semibold text-[var(--c-action)]">
                        {i18n.t('settlement.recent.open')}
                      </span>
                    </button>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <Card>
              <CardBody>
                <p className="text-body-sm text-[var(--c-fg-muted)]">
                  {i18n.t('settlement.recent.empty')}
                </p>
              </CardBody>
            </Card>
          )}
        </section>
      </div>

      <Sheet
        open={!!wagePickerFor}
        onOpenChange={(open) => {
          if (open) return;
          closeWagePicker();
        }}
        title={i18n.t('settlement.wages.pickerTitle')}
        description={i18n.t('settlement.wages.pickerDescription')}
      >
        <div className="flex flex-col gap-3 py-2">
          <Field label={i18n.t('settlement.wages.roleFilter')}>
            <Select
              value={wageRoleFilter}
              onChange={(event) => setWageRoleFilter(event.currentTarget.value)}
            >
              <option value="">{i18n.t('settlement.wages.allRoles')}</option>
              {wageRoleOptions.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          </Field>
          <SearchInput
            value={wageSearch}
            placeholder={i18n.t('settlement.wages.searchEmployees')}
            aria-label={i18n.t('settlement.wages.searchEmployees')}
            clearAriaLabel={i18n.t('common.clear')}
            onChange={(event) => setWageSearch(event.currentTarget.value)}
            onClear={() => setWageSearch('')}
          />

          {wageRosterQuery.isPending ? (
            <div className="flex justify-center py-5">
              <Spinner size={20} />
            </div>
          ) : null}
          {wageRosterQuery.isError ? (
            <Banner
              tone="danger"
              title={i18n.t('settlement.wages.rosterError')}
              action={
                <Button size="sm" variant="pearl" onClick={() => void wageRosterQuery.refetch()}>
                  {i18n.t('settlement.action.refresh')}
                </Button>
              }
            />
          ) : null}
          {!wageRosterQuery.isPending && !wageRosterQuery.isError && wageRoster.length === 0 ? (
            <EmptyState
              title={i18n.t('settlement.wages.rosterEmptyTitle')}
              description={i18n.t('settlement.wages.rosterEmptyBody')}
            />
          ) : null}
          {!wageRosterQuery.isPending &&
          !wageRosterQuery.isError &&
          wageRoster.length > 0 &&
          filteredWageRoster.length === 0 ? (
            <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2 text-body-sm text-[var(--c-fg-muted)]">
              {i18n.t('settlement.wages.noEmployeeMatch')}
            </p>
          ) : null}
          {!wageRosterQuery.isPending &&
          !wageRosterQuery.isError &&
          filteredWageRoster.length > 0 ? (
            <ul className="flex flex-col gap-2" role="list">
              {filteredWageRoster.map((employee) => (
                <li key={employee.memberId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-3 text-left ring-hairline transition-colors hover:bg-[var(--c-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-ring)]"
                    onClick={() => selectWageEmployee(employee)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-body font-semibold text-[var(--c-fg)]">
                        {employee.displayName}
                      </span>
                      <span className="mt-0.5 block truncate text-label text-[var(--c-fg-muted)]">
                        {employee.roles.length > 0
                          ? employee.roles.map((role) => role.name).join(' · ')
                          : i18n.t('settlement.wages.noRole')}
                      </span>
                    </span>
                    <span className="shrink-0 text-label font-semibold text-[var(--c-action)]">
                      {i18n.t('settlement.wages.chooseEmployee')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}
