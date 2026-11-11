/**
 * SettlementPage — one store's end-of-day cash close.
 *
 * A daily close is deliberately a small, explicit record rather than a
 * calculated sales report: the cashier records what happened and the API
 * keeps a versioned correction trail.  This screen therefore never infers
 * cash from other modules or silently overwrites an existing close.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
  FieldError,
  Input,
  LoadingState,
  NumberInput,
  PendingState,
  SearchInput,
  SectionLabel,
  Select,
  Sheet,
  Textarea,
  useToast,
  QueryErrorBanner,
} from '@compass/ui';
import type { SettlementWageItem } from '@compass/contracts';
import {
  BACKDATE_LIMIT_DAYS,
  isoDateDaysBefore,
  SETTLEMENT_DETAIL_ITEMS_MAX as MAX_DETAIL_ITEMS,
  SETTLEMENT_MAX_CENTS,
  settlementMoneyProblem,
} from '@compass/contracts/limits';
import { newIdempotencyKey, trpc } from '../lib/trpc';
import { NoStoreYet, useNoStoreYet } from '../components/NoStoreYet';
import { registerStoreChangeGuard, useStoreContext } from '../components/StoreSwitcher';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { confirmNative } from '../lib/confirm';
import { showFieldError, withTouched } from '../lib/fieldErrors';
import { useErrToast } from '../lib/errToast';
import { useDateFormat, useI18n, useRoleLabels } from '../hooks/useI18n';
import { zoneName } from '../lib/dateFormat';
import { formatMoney, currencyOf } from '../lib/format';
import { scrollBehavior } from '../lib/reducedMotion';
import { useAuthStore } from '../stores/authStore';
import { useRefreshSession } from '../lib/refreshSession';
import { registerTabChangeGuard } from '../stores/navStore';
import { StoreSalesPanel } from '../components/sales/StoreSalesPanel';
import {
  draftKey,
  draftStorage,
  forgetDraft,
  pruneDrafts,
  readDraft,
  writeDraft,
} from './settlement/draftStore';
import { addMoney, centsToMoney, toCents } from '@compass/contracts/money';
import {
  ITEM_MONEY_PROBLEM_MESSAGE,
  MONEY_PROBLEM_MESSAGE,
  moneyProblem,
} from './settlement/moneyProblem';

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

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
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
  if (settlementMoneyProblem(raw, { signed: true })) return raw || '0';
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

type CarriedFields = Partial<Pick<SettlementDraft, MoneyField | 'note' | 'correctionReason'>>;

/** The typed fields that differ from the record the form was loaded from. */
function editedFields(draft: SettlementDraft, base: SettlementDraft): CarriedFields {
  const carried: CarriedFields = {};
  for (const key of [...MONEY_FIELDS, 'note', 'correctionReason'] as const) {
    if (draft[key] !== base[key]) carried[key] = draft[key];
  }
  return carried;
}

/** Expense / wage lines compared by content (the local row ids are random). */
function linesEdited(draft: SettlementDraft, base: SettlementDraft): boolean {
  const lines = (d: SettlementDraft) =>
    JSON.stringify([
      d.operatingExpenseItems.map(({ id: _id, ...rest }) => rest),
      d.wageItems.map(({ id: _id, ...rest }) => rest),
    ]);
  return lines(draft) !== lines(base);
}

function moneyNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Match the API's two-decimal normalization when deciding if this is a
 * correction. CONF-08: the amount rule and the cents are the shared ones
 * (contracts limits / money), as on the server.
 */
function normalizedMoney(value: string): string {
  const raw = value.trim();
  return isMoney(raw, true) ? centsToMoney(toCents(raw)) : raw;
}

function isMoney(value: string, signed = false): boolean {
  return settlementMoneyProblem(value.trim(), { signed }) === null;
}

/** A valid, unsigned amount in cents; null otherwise. */
function moneyToCents(value: string): bigint | null {
  const raw = value.trim();
  return isMoney(raw) ? toCents(raw) : null;
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
    if (cents > SETTLEMENT_MAX_CENTS) return { value: '0.00', valid: false };
  }
  return { value: centsToMoney(cents), valid: true };
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

/** DX-CLS-4: `null` while a field it adds up is invalid — shown as "—". */
function SummaryRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-old-body-sm">
      <span className="text-[var(--c-fg-muted)]">{label}</span>
      <strong className="shrink-0 tabular-nums text-[var(--c-fg)]">{value ?? '—'}</strong>
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
  revealError,
  onLeave,
  onChange,
}: {
  label: string;
  value: string;
  signed?: boolean;
  /**
   * Review CONF-21: whether a problem may show yet. Like the expense and
   * wage lines (DX-VIS-15), once the field was left or a save was tried;
   * it used to show from the first keystroke.
   */
  revealError: boolean;
  onLeave: () => void;
  onChange: (value: string) => void;
}) {
  const i18n = useI18n();
  const errorId = useId();
  // DX-CLS-4 (2026-11-01): one sentence per reason; negative, empty and
  // too long all read "enter a number, at most two decimals".
  const problem = isMoney(value, signed) ? null : (moneyProblem(value, { signed }) ?? 'notNumber');
  const shown = problem !== null && revealError;
  // A11Y-2 (2026-10-31): the reason sits under the field it is about and
  // is tied to it with aria-describedby. It used to be one unnamed banner
  // ~1,100 px further down, and the field only turned its edge red (hidden
  // under the focus ring while typing).
  return (
    <Field label={label}>
      <NumberInput
        value={value}
        min={signed ? '-999999999999.99' : '0'}
        max="999999999999.99"
        step="0.01"
        placeholder="0"
        aria-label={label}
        aria-invalid={shown || undefined}
        aria-describedby={shown ? errorId : undefined}
        // The line below covers "not a number" too; one message, not two.
        formatError="none"
        className={shown ? 'border-[var(--c-danger)]' : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onLeave}
      />
      {problem !== null && shown ? (
        <FieldError id={errorId}>
          {i18n.t(MONEY_PROBLEM_MESSAGE[problem], { field: label })}
        </FieldError>
      ) : null}
    </Field>
  );
}

/**
 * A11Y-2: focus the first field marked invalid inside `root` and bring it
 * into view. Returns false when there is none.
 */
function focusFirstInvalid(root: HTMLElement | null): boolean {
  const field = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!field) return false;
  field.focus({ preventScroll: true });
  field.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  return true;
}

const confirmSettlement = confirmNative;

function confirmSettlementAction(message: string, onConfirm: () => void): void {
  void confirmSettlement(message).then((confirmed) => {
    if (confirmed) onConfirm();
  });
}

export function SettlementPage() {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const dates = useDateFormat();
  const toast = useToast();
  const errToast = useErrToast();
  const session = useAuthStore((state) => state.session);
  const storeCtx = useStoreContext();
  const noStoreYet = useNoStoreYet();
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
  // CLS-18: the record the form was loaded from, and the user's own typed
  // fields to put back on top of a newer version after a conflict refresh.
  const baseDraft = useRef<SettlementDraft>(emptyDraft());
  const carryOver = useRef<{ at: string; fields: CarriedFields } | null>(null);
  // F18 (2026-11-05): true while the form shows unsaved input brought back
  // from this device (see settlement/draftStore).
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [wagePickerFor, setWagePickerFor] = useState<string | null>(null);
  const [newWagePickerFor, setNewWagePickerFor] = useState<string | null>(null);
  const [wageRoleFilter, setWageRoleFilter] = useState('');
  const [wageSearch, setWageSearch] = useState('');
  const [fillingFromAttendance, setFillingFromAttendance] = useState(false);
  // 2026-10-21 CA-09: sales entry block (see render). The flat session
  // set is only a hint; sales.record enforces the store-level override.
  const canRecordSales = session?.permissions.includes('sales.record') ?? false;
  const [salesOpen, setSalesOpen] = useState(false);
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
  // CONF-02 (2026-11-09): a store assigned since the session was read is
  // in this page's list but not yet in the session, so it never became
  // the shell's store and the page waited for that forever. Read the
  // session again; the store then joins it.
  const refreshSession = useRefreshSession();
  const storeNotInSession =
    !!currentStoreId && !(session?.stores ?? []).some((store) => store.id === currentStoreId);
  useEffect(() => {
    if (storeNotInSession) void refreshSession();
  }, [storeNotInSession, refreshSession]);

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
    const fresh = existing ? draftFromRecord(existing) : emptyDraft();
    baseDraft.current = fresh;
    const carry = carryOver.current;
    carryOver.current = null;
    const stored =
      session && BUSINESS_DATE.test(date)
        ? readDraft<SettlementDraft>(draftStorage(), draftKey(session.user.id, recordKey))
        : null;
    // CONF-13: tidy the other drafts. Only a record that has loaded says
    // which versions are behind it; while it loads, recordKey reads "new".
    if (session && BUSINESS_DATE.test(date)) {
      pruneDrafts(
        draftStorage(),
        draftKey(session.user.id, recordKey),
        existing
          ? {
              prefix: draftKey(session.user.id, `${currentStoreId}:${date}:${existing.id}:`),
              version: existing.version,
            }
          : null,
      );
    }
    if (carry && carry.at === `${currentStoreId}:${date}` && Object.keys(carry.fields).length) {
      setDraft({ ...fresh, ...carry.fields });
      setRestoredDraft(false);
      toast.info(i18n.t('settlement.conflict.keptEdits'));
    } else if (stored) {
      setDraft({ ...fresh, ...stored });
      setRestoredDraft(true);
    } else {
      setDraft(fresh);
      setRestoredDraft(false);
    }
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
  // The draft for the record on screen is in. In the render that brings a
  // record, the form still holds the previous one's (or an empty) draft
  // until the effect above replaces it: nothing anyone typed. Counted as
  // changes, a tap on another tab right then asked "discard the changes
  // you have not saved?" about a close saved a moment ago (seen in CI just
  // after a reload).
  const draftLoaded = draftRecordKey === recordKey;
  const hasUnsavedChanges =
    draftLoaded &&
    (existing !== null
      ? hasChanges
      : DIRECT_MONEY_FIELDS.some((field) => normalizedMoney(draft[field]) !== '0.00') ||
        draft.note.trim().length > 0 ||
        draft.operatingExpenseItems.length > 0 ||
        draft.wageItems.length > 0);
  const confirmDiscard = () =>
    hasUnsavedChanges
      ? confirmSettlement(i18n.t('settlement.confirm.discard'))
      : Promise.resolve(true);
  // F18: keep unsaved input on the device while it differs from the record,
  // and drop it once it matches again (saved, or typed back).
  const storedDraftKey = session ? draftKey(session.user.id, recordKey) : null;
  useEffect(() => {
    if (!storedDraftKey || !draftLoaded) return;
    if (hasUnsavedChanges) writeDraft(draftStorage(), storedDraftKey, draft);
    else forgetDraft(draftStorage(), storedDraftKey);
  }, [storedDraftKey, draftLoaded, hasUnsavedChanges, draft]);
  const forgetStoredDraft = () => {
    if (storedDraftKey) forgetDraft(draftStorage(), storedDraftKey);
    setRestoredDraft(false);
  };
  const discardRestoredDraft = () => {
    forgetStoredDraft();
    setDraft(baseDraft.current);
  };
  const confirmDiscardChanges = (onConfirm: () => void) => {
    void confirmDiscard().then((confirmed) => {
      if (confirmed) forgetStoredDraft();
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
        // CONF-13: "discard" drops the stored draft too, as the page's own
        // store and date pickers do; it used to come back as "restored".
        return confirmSettlement(i18n.t('settlement.confirm.discard')).then((ok) => {
          if (ok && storedDraftKey) forgetDraft(draftStorage(), storedDraftKey);
          return ok;
        });
      }),
    [hasUnsavedChanges, i18n, requestedStoreId, storedDraftKey],
  );
  // The shell only renders the active bottom-tab page, so leaving this tab
  // otherwise unmounts the form. Keep the same explicit confirmation used
  // for store/date changes before allowing that destructive transition.
  useEffect(
    () =>
      registerTabChangeGuard((nextTab) => {
        // R2-CLS-2 (2026-10-31): a save already on its way finishes after
        // the page closes (its "saved" toast shows on the next tab), so
        // asking to "discard" it was false. Only unsent changes ask.
        if (nextTab === 'settlement' || !hasUnsavedChanges || savingRef.current) return true;
        return confirmSettlement(i18n.t('settlement.confirm.discard')).then((ok) => {
          if (ok && storedDraftKey) forgetDraft(draftStorage(), storedDraftKey);
          return ok;
        });
      }),
    [hasUnsavedChanges, i18n, storedDraftKey],
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
  // CLS-14: a NEW close may be at most BACKDATE_LIMIT_DAYS back; an
  // existing older one can still be corrected.
  const tooOldForNew =
    !!businessDate &&
    !existing &&
    !closeQuery.isFetching &&
    date < isoDateDaysBefore(businessDate.date, BACKDATE_LIMIT_DAYS);
  const canSave =
    !!currentStoreId &&
    draftSynchronized &&
    dateValid &&
    !tooOldForNew &&
    !invalidMoney &&
    !invalidDetails &&
    hasChanges &&
    correctionReady &&
    !versionConflict &&
    !closeQuery.isFetching &&
    !closeQuery.isError;
  // A11Y-2: how many fields stop the save, for the banner under the form
  // ("2 栏需要改正") and the save button, which now stays focusable and
  // jumps to the first of them instead of being silently disabled.
  const fieldsToFix =
    DIRECT_MONEY_FIELDS.filter(
      (field) => !isMoney(draft[field], field === 'priorPurchaseAdjustment'),
    ).length +
    draft.operatingExpenseItems.filter((item) => !isValidOperatingExpense(item)).length +
    draft.wageItems.filter((item) => !isValidWageItem(item, wageSelectionRequired)).length +
    (correctionReady ? 0 : 1);
  const formRef = useRef<HTMLFieldSetElement>(null);
  // DX-VIS-15 (2026-11-01): expense and wage lines are marked red only
  // after their field was left or a save was tried, not as they appear.
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(() => new Set());
  const [saveTried, setSaveTried] = useState(false);
  const touch = (key: string) => setTouchedFields((cur) => withTouched(cur, key));
  const showError = (invalid: boolean, key: string) =>
    showFieldError(invalid, touchedFields, key, saveTried);
  // CONF-21: the top amounts reveal a problem the same way.
  const revealFor = (field: MoneyField) => ({
    revealError: saveTried || touchedFields.has(field),
    onLeave: () => touch(field),
  });
  const showFirstFieldToFix = () => {
    // The marks must be on screen before focus can find the first one.
    flushSync(() => setSaveTried(true));
    focusFirstInvalid(formRef.current);
  };
  const canRecordOperatingExpenses = businessDate?.canRecordOperatingExpenses ?? false;
  const canEditOperatingExpenses =
    canRecordOperatingExpenses && !hasHistoricalOperatingExpenseTotal;
  const wageRoster = (wageRosterQuery.data ?? []) as WageRosterMember[];
  const wageRoleOptions = useMemo(() => {
    const byId = new Map<string, WageRosterMember['roles'][number]>();
    for (const employee of wageRoster) {
      for (const role of employee.roles) byId.set(role.id, role);
    }
    // CONF-18: in the order the names are shown (built-in roles are
    // translated), in the UI language's collation.
    return [...byId.values()].sort((left, right) =>
      roleText.name(left).localeCompare(roleText.name(right), i18n.locale),
    );
  }, [wageRoster, roleText, i18n.locale]);
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
  // DX-CLS-4 (2026-11-01): a line whose inputs are not valid amounts shows
  // "—" instead of e.g. "-5 UZS" or "99,999,999,999,999 UZS".
  const summary = {
    // DX-PFE-12: added in cents, so 0.10 + 0.20 shows 0.30 (D1).
    totalRevenue:
      isMoney(draft.onlineRevenue) && isMoney(draft.invoicedCashRevenue)
        ? addMoney(onlineRevenue, invoicedCashRevenue)
        : null,
    paidOutflows:
      operatingExpenseTotal.valid && paidWageTotal.valid
        ? addMoney(operatingExpenses, wagesPaid)
        : null,
    futureCommitments:
      unpaidWageTotal.valid && isMoney(draft.nextPurchaseReserve)
        ? addMoney(wagesAccrued, nextPurchaseReserve)
        : null,
    priorPurchaseAdjustment: isMoney(draft.priorPurchaseAdjustment, true)
      ? priorPurchaseAdjustment
      : null,
    endingCash: isMoney(draft.cashOnHand) ? cashOnHand : null,
  };

  // CLS-17 (2026-10-30): one key per logical save. Every request used to
  // get a new one, so a retry after a lost response looked like someone
  // else's edit ("changed elsewhere"). Same content → same key.
  const saveIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  // Read by the tab guard above, which is registered before the mutation.
  const savingRef = useRef(false);
  const saveIdemFor = useRef('');
  const saveMutation = trpc.settlement.save.useMutation({
    trpc: { context: saveIdemCtx },
    onSuccess: (saved) => {
      saveIdemFor.current = '';
      forgetStoredDraft();
      const savedRecord = saved as SettlementRecord;
      baseDraft.current = draftFromRecord(savedRecord);
      setDraft(baseDraft.current);
      setDraftRecordKey(
        `${savedRecord.storeId}:${savedRecord.date}:${savedRecord.id}:${savedRecord.version}`,
      );
      setVersionConflict(false);
      haptic('success');
      toast.success(i18n.t('settlement.saved'));
      void utils.settlement.get.invalidate({ storeId: saved.storeId, date: saved.date });
      void utils.settlement.recent.invalidate({ storeId: saved.storeId });
      // RE-CLS-1 (2026-10-31): the change history gained a version.
      void utils.settlement.revisions.invalidate({ settlementId: savedRecord.id });
      // DX-SHL-23: the 日结 tab's "not filed today" dot.
      void utils.nav.counts.invalidate();
    },
    onError: (error) => {
      if (isVersionConflict(error)) {
        setVersionConflict(true);
        haptic('warning');
        return;
      }
      // The server names what to fix (an employee who left, totals that do not
      // add up, a missing correction reason); show that, not "try again".
      // CLS-17: the same content is sent with the same key, so saving
      // again after a lost answer cannot record it twice.
      errToast('settlement.errors.save', { retrySafe: true })(error);
    },
  });

  savingRef.current = saveMutation.isPending;

  // CLS-24 / R2-INT-3 (2026-10-31): a NEW close with every amount 0 and
  // no lines is usually an untouched form, not a closed-and-empty day;
  // it needs a yes before it is stored.
  const allZeroNew =
    !existing &&
    DIRECT_MONEY_FIELDS.every((field) => normalizedMoney(draft[field]) === '0.00') &&
    draft.operatingExpenseItems.length === 0 &&
    draft.wageItems.length === 0;
  const save = () => {
    if (!currentStoreId || !canSave || saveMutation.isPending) return;
    if (allZeroNew) {
      confirmSettlementAction(i18n.t('settlement.confirm.allZero'), submitSave);
      return;
    }
    submitSave();
  };

  const submitSave = () => {
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
    const input = {
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
    };
    const signature = JSON.stringify(input);
    if (signature !== saveIdemFor.current) {
      saveIdemFor.current = signature;
      saveIdemCtx.idempotencyKey = newIdempotencyKey();
    }
    saveMutation.mutate(input);
  };

  const refreshRecord = () => {
    const reload = () => {
      setVersionConflict(false);
      void closeQuery.refetch();
      void recentQuery.refetch();
    };
    // CLS-18: after a version conflict the newer record loads and the
    // amounts / note this user typed are put back on top of it. Only
    // expense and wage lines cannot be carried over, so ask about those.
    if (versionConflict) {
      carryOver.current = {
        at: `${currentStoreId}:${date}`,
        fields: editedFields(draft, baseDraft.current),
      };
      if (linesEdited(draft, baseDraft.current)) {
        void confirmSettlement(i18n.t('settlement.conflict.linesLost')).then((ok) => {
          if (ok) reload();
          else carryOver.current = null;
        });
      } else {
        reload();
      }
      return;
    }
    confirmDiscardChanges(reload);
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
      draftSynchronized &&
      !closeQuery.isError &&
      !tooOldForNew,
    active: canSave && !saveMutation.isPending,
    onInactiveClick: fieldsToFix > 0 ? showFirstFieldToFix : undefined,
  });

  if (!session) return null;

  // Shared by the form and the invalid-date state below (CLS-4).
  const dateField = businessDate ? (
    <Field
      label={i18n.t('settlement.date.label')}
      hint={i18n.t('settlement.date.timezone', {
        timezone: zoneName(businessDate.timezone, i18n.locale),
      })}
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
  ) : null;
  // UI-12 (2026-11-05): a tab page carries no visible title — the bottom
  // nav names it (Order, Review, Run, Receive, History already work this
  // way). The Shell's hidden <h1> keeps the heading for screen readers.
  const pageHeading = null;
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
        <PendingState query={storesQuery} variant="block" />
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
        {noStoreYet ? (
          <NoStoreYet />
        ) : (
          <EmptyState
            title={i18n.t('settlement.noEligibleStores.title')}
            description={i18n.t('settlement.noEligibleStores.body')}
          />
        )}
      </div>
    );
  }

  // Do not render Store A's form under Store B's shell label even for the
  // single paint before the synchronization effect updates global context.
  if (currentStoreId !== requestedStoreId) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        <LoadingState />
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
          <PendingState query={businessDateQuery} variant="block" />
        )}
      </div>
    );
  }

  // Query caches can resolve a different store/date before the draft-reset
  // effect runs. Do not briefly render any prior form under this context, and
  // do not offer an empty form while the selected close is still loading.
  // CLS-4 (2026-10-30): a future or cleared date disables the close query,
  // and a disabled query stays `isPending`, so this page spun forever with
  // the date field gone. Keep the field and say what is wrong instead.
  if (businessDate && !dateValid) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        {storeSelector}
        {dateField}
        <Banner
          tone="warn"
          title={i18n.t(
            BUSINESS_DATE.test(date)
              ? 'settlement.errors.futureDate'
              : 'settlement.errors.dateMissing',
          )}
        />
      </div>
    );
  }

  if (!draftSynchronized) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {pageHeading}
        {storeSelector}
        {/* CONF-02: offline with no saved copy of this day, say so; a
            bare spinner turned until the network came back. */}
        <PendingState query={closeQuery} variant="block" />
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

  // Attendance phase 2 (2026-11-05): the day's wages from attendance —
  // daily wage less late / early — as unpaid rows the cashier confirms.
  const fillFromAttendance = async () => {
    if (!currentStoreId || !dateValid || hasHistoricalWageTotal) return;
    setFillingFromAttendance(true);
    try {
      const rows = await utils.attendance.wageSuggestions.fetch({ storeId: currentStoreId, date });
      const present = new Set(draft.wageItems.map((item) => item.memberId).filter(Boolean));
      const payable = rows.filter(
        (r) =>
          r.status === 'payable' &&
          r.amount !== null &&
          Number(r.amount) > 0 &&
          !present.has(r.memberId),
      );
      const review = rows.filter((r) => r.status === 'needsReview' || r.status === 'noRate').length;
      if (payable.length === 0) {
        haptic('warning');
        toast.info(
          review > 0
            ? i18n.t('settlement.wages.fromAttendanceNeedsReview', { n: review })
            : i18n.t('settlement.wages.fromAttendanceNone'),
        );
        return;
      }
      const room = MAX_DETAIL_ITEMS - draft.wageItems.length;
      const added = payable.slice(0, Math.max(0, room)).map((r) => ({
        id: newDetailId(),
        persistedId: null,
        memberId: r.memberId,
        personName: r.name,
        status: 'unpaid' as const,
        amount: r.amount!,
        reason:
          r.missedMinutes > 0
            ? i18n.t('settlement.wages.fromAttendanceReasonMissed', {
                wage: formatMoney(r.dailyWage, currency),
                late: r.lateMinutes,
                early: r.earlyMinutes,
                missed: r.missedMinutes,
                deduction: formatMoney(r.deduction, currency),
              })
            : r.lateMinutes + r.earlyMinutes > 0
              ? i18n.t('settlement.wages.fromAttendanceReasonDeducted', {
                  wage: formatMoney(r.dailyWage, currency),
                  late: r.lateMinutes,
                  early: r.earlyMinutes,
                  deduction: formatMoney(r.deduction, currency),
                })
              : i18n.t('settlement.wages.fromAttendanceReason', {
                  wage: formatMoney(r.dailyWage, currency),
                }),
        isHistorical: false,
      }));
      haptic('success');
      setDraft((current) => ({ ...current, wageItems: [...current.wageItems, ...added] }));
      // CONF-18: the two sentences join the way the language does (no
      // space after 。 in Chinese).
      const addedText = i18n.t('settlement.wages.fromAttendanceAdded', { n: added.length });
      toast.success(
        review > 0
          ? i18n.t('common.twoSentences', {
              first: addedText,
              second: i18n.t('settlement.wages.fromAttendanceNeedsReview', { n: review }),
            })
          : addedText,
      );
    } catch (err) {
      errToast('settlement.wages.fromAttendanceFailed')(err);
    } finally {
      setFillingFromAttendance(false);
    }
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
        {/* 2026-11-05: store and business date sit in a card like every
            other group on this page; outside one, their labels started
            16 px left of the section labels and card fields below. */}
        {storeSelector || dateField ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              {storeSelector}
              {dateField}
            </CardBody>
          </Card>
        ) : null}

        {canRecordSales ? (
          // 2026-10-21 CA-09: cashiers only get this tab, so sales entry
          // lives here too. Self-contained (own state + mutation, keyed by
          // store so a half-picked dish never carries over); it never
          // touches `draft`, so the dirty-form guards and MainButton save
          // keep tracking the settlement alone. Collapsed by default so
          // the (up to 200-row) list doesn't push the close form away and
          // its queries only run once opened.
          <section className="flex flex-col gap-2">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2.5 text-left ring-hairline"
              aria-expanded={salesOpen}
              onClick={() => setSalesOpen((open) => !open)}
            >
              <span className="text-old-body font-semibold">{i18n.t('sales.list.title')}</span>
              <span aria-hidden className="text-[var(--c-fg-muted)]">
                {salesOpen ? '▾' : '▸'}
              </span>
            </button>
            {salesOpen ? (
              <StoreSalesPanel key={currentStoreId} storeId={currentStoreId} className="" />
            ) : null}
          </section>
        ) : null}

        {closeQuery.isError ? (
          // CLS-15 (2026-10-30): a failed LOAD said "could not save".
          <Banner
            tone="danger"
            title={i18n.t('settlement.errors.load')}
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

        {tooOldForNew ? (
          <Banner
            tone="warn"
            title={i18n.t('settlement.errors.dateTooOld', { days: BACKDATE_LIMIT_DAYS })}
          />
        ) : null}
        {restoredDraft && hasUnsavedChanges && !tooOldForNew ? (
          <Banner
            tone="info"
            title={i18n.t('settlement.draftRestored.title')}
            action={
              <Button size="sm" variant="pearl" onClick={discardRestoredDraft}>
                {i18n.t('settlement.draftRestored.discard')}
              </Button>
            }
          >
            {i18n.t('settlement.draftRestored.body')}
          </Banner>
        ) : null}
        {existing ? (
          <Banner tone="info" title={i18n.t('settlement.editing.title')}>
            {i18n.t('settlement.editing.body')}
          </Banner>
        ) : null}
        {existing && existing.version > 1 ? (
          <SettlementHistory key={existing.id} settlementId={existing.id} />
        ) : null}

        {/* CLS-15 (2026-10-31): while the day failed to load there is no
            form — an empty one with 「保存日结」 read as "nothing saved yet"
            when the day may already have a close. */}
        {/* F21 (2026-11-05): a date too old for a new close used to keep
            the whole form and its save button under the warning. */}
        {closeQuery.isError || tooOldForNew ? null : (
          <>
            {/* CLS-16: while a save is in flight the form is locked; whatever was
            typed meanwhile used to be overwritten by the saved record. */}
            <fieldset
              ref={formRef}
              disabled={saveMutation.isPending}
              aria-busy={saveMutation.isPending}
              className="contents"
            >
              <section className="flex flex-col gap-2">
                <SectionLabel as="h2">{i18n.t('settlement.group.revenue')}</SectionLabel>
                <Card>
                  <CardBody className="flex flex-col gap-3">
                    <CardMeta>{i18n.t('settlement.field.amountHint')}</CardMeta>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <AmountField
                        label={i18n.t('settlement.field.onlineRevenue')}
                        value={draft.onlineRevenue}
                        {...revealFor('onlineRevenue')}
                        onChange={(value) => setMoney('onlineRevenue', value)}
                      />
                      <AmountField
                        label={i18n.t('settlement.field.invoicedCashRevenue')}
                        value={draft.invoicedCashRevenue}
                        {...revealFor('invoicedCashRevenue')}
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
                      {/* The add button keeps its full label; in ru / uz at 360 px it was
                    squeezed and cut off. The row wraps instead. */}
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-old-h3 font-semibold text-[var(--c-fg)]">
                            {i18n.t('settlement.expenses.title')}
                          </h3>
                          <p className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                            {i18n.t('settlement.expenses.total', {
                              money: formatMoney(operatingExpenseTotal.value, currency),
                            })}
                          </p>
                        </div>
                        <Button
                          className="shrink-0"
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
                        <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
                          {i18n.t('settlement.expenses.empty')}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {draft.operatingExpenseItems.map((expense, index) => {
                            const valid = isValidOperatingExpense(expense);
                            // DX-CLS-3 (2026-11-01): each bad field says why, and
                            // its name carries the line number for a screen reader
                            // ("支出 2 · 金额"); the rows only turned red before.
                            const itemLabel = i18n.t('settlement.expenses.itemNumber', {
                              n: index + 1,
                            });
                            const amountLabel = `${itemLabel} · ${i18n.t('settlement.expenses.amount')}`;
                            const reasonLabel = `${itemLabel} · ${i18n.t('settlement.expenses.reason')}`;
                            // DX-VIS-15: a problem shows once the field was left
                            // or a save was tried, not as the line appears.
                            const rawAmountProblem = expense.isHistorical
                              ? null
                              : moneyProblem(expense.amount, { positive: true });
                            const amountProblem = showError(
                              rawAmountProblem !== null,
                              `${expense.id}:amount`,
                            )
                              ? rawAmountProblem
                              : null;
                            const reasonMissing = showError(
                              !expense.isHistorical && expense.reason.trim().length === 0,
                              `${expense.id}:reason`,
                            );
                            const amountErrorId = `expense-${expense.id}-amount-error`;
                            const reasonErrorId = `expense-${expense.id}-reason-error`;
                            return (
                              <div
                                key={expense.id}
                                className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] p-3 ring-hairline"
                              >
                                <div className="mb-3 flex items-center justify-between gap-3">
                                  <span className="text-old-label font-semibold text-[var(--c-fg-muted)]">
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
                                    aria-label={amountLabel}
                                    aria-invalid={amountProblem !== null || undefined}
                                    aria-describedby={amountProblem ? amountErrorId : undefined}
                                    formatError="none"
                                    className={
                                      amountProblem ? 'border-[var(--c-danger)]' : undefined
                                    }
                                    onBlur={() => touch(`${expense.id}:amount`)}
                                    onChange={(event) =>
                                      updateOperatingExpense(expense.id, {
                                        amount: event.currentTarget.value,
                                        isHistorical: false,
                                      })
                                    }
                                  />
                                  {amountProblem ? (
                                    <FieldError id={amountErrorId}>
                                      {i18n.t(ITEM_MONEY_PROBLEM_MESSAGE[amountProblem], {
                                        field: amountLabel,
                                      })}
                                    </FieldError>
                                  ) : null}
                                </Field>
                                <div className="mt-3">
                                  <Field label={i18n.t('settlement.expenses.reason')}>
                                    {expense.isHistorical ? (
                                      <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-3)] px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
                                        {i18n.t('settlement.expenses.historicalReason')}
                                      </p>
                                    ) : (
                                      <>
                                        <Textarea
                                          value={expense.reason}
                                          maxLength={500}
                                          readOnly={!canEditOperatingExpenses}
                                          aria-label={reasonLabel}
                                          invalid={!valid && reasonMissing}
                                          aria-describedby={
                                            !valid && reasonMissing ? reasonErrorId : undefined
                                          }
                                          onBlur={() => touch(`${expense.id}:reason`)}
                                          onChange={(event) =>
                                            updateOperatingExpense(expense.id, {
                                              reason: event.currentTarget.value,
                                              isHistorical: false,
                                            })
                                          }
                                        />
                                        {!valid && reasonMissing ? (
                                          <FieldError id={reasonErrorId}>
                                            {i18n.t('settlement.errors.itemReasonEmpty', {
                                              field: reasonLabel,
                                            })}
                                          </FieldError>
                                        ) : null}
                                      </>
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
                      {/* The add button keeps its full label; in ru / uz at 360 px it was
                    squeezed and cut off. The row wraps instead. */}
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-old-h3 font-semibold text-[var(--c-fg)]">
                            {i18n.t('settlement.wages.title')}
                          </h3>
                          <p className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                            {i18n.t('settlement.wages.totals', {
                              paid: formatMoney(paidWageTotal.value, currency),
                              unpaid: formatMoney(unpaidWageTotal.value, currency),
                            })}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={fillingFromAttendance}
                            disabled={
                              hasHistoricalWageTotal || draft.wageItems.length >= MAX_DETAIL_ITEMS
                            }
                            onClick={() => void fillFromAttendance()}
                          >
                            {i18n.t('settlement.wages.fromAttendance')}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={
                              hasHistoricalWageTotal || draft.wageItems.length >= MAX_DETAIL_ITEMS
                            }
                            onClick={addWageItem}
                          >
                            {i18n.t('settlement.wages.add')}
                          </Button>
                        </div>
                      </div>

                      {hasHistoricalWageTotal ? (
                        <Banner tone="info" title={i18n.t('settlement.details.historicalReadOnly')}>
                          {i18n.t('settlement.details.historicalReadOnlyBody')}
                        </Banner>
                      ) : null}

                      {draft.wageItems.length === 0 ? (
                        <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
                          {i18n.t('settlement.wages.empty')}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {draft.wageItems.map((wage, index) => {
                            const valid = isValidWageItem(wage, wageSelectionRequired);
                            // DX-CLS-3: as for expense lines above.
                            const itemLabel = i18n.t('settlement.wages.itemNumber', {
                              n: index + 1,
                            });
                            const amountLabel = `${itemLabel} · ${i18n.t('settlement.wages.amount')}`;
                            const reasonLabel = `${itemLabel} · ${i18n.t('settlement.wages.reason')}`;
                            // DX-VIS-15: as for expense lines above.
                            const rawAmountProblem = wage.isHistorical
                              ? null
                              : moneyProblem(wage.amount, { positive: true });
                            const amountProblem = showError(
                              rawAmountProblem !== null,
                              `${wage.id}:amount`,
                            )
                              ? rawAmountProblem
                              : null;
                            const reasonMissing = showError(
                              !wage.isHistorical && wage.reason.trim().length === 0,
                              `${wage.id}:reason`,
                            );
                            const employeeMissing =
                              !wage.isHistorical && wageSelectionRequired && !wage.memberId;
                            const amountErrorId = `wage-${wage.id}-amount-error`;
                            const reasonErrorId = `wage-${wage.id}-reason-error`;
                            const employeeErrorId = `wage-${wage.id}-employee-error`;
                            const displayedEmployee = wage.isHistorical
                              ? i18n.t('settlement.wages.historicalEmployee')
                              : wage.personName || i18n.t('settlement.wages.chooseEmployee');
                            return (
                              <div
                                key={wage.id}
                                className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] p-3 ring-hairline"
                              >
                                <div className="mb-3 flex items-center justify-between gap-3">
                                  <span className="text-old-label font-semibold text-[var(--c-fg-muted)]">
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
                                      // 2026-11-11: inside the field's <label>
                                      // the button was named by the label
                                      // alone, so a screen reader said
                                      // "Employee" and never who was chosen.
                                      aria-label={i18n.t('common.labelValue', {
                                        label: i18n.t('settlement.wages.employee'),
                                        value: displayedEmployee,
                                      })}
                                      aria-haspopup="dialog"
                                      aria-invalid={employeeMissing || undefined}
                                      aria-describedby={
                                        employeeMissing ? employeeErrorId : undefined
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
                                      <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
                                        {i18n.t('settlement.wages.legacyEmployee')}
                                      </p>
                                    ) : null}
                                    {employeeMissing ? (
                                      <FieldError id={employeeErrorId}>
                                        {i18n.t('settlement.errors.employeeRequired')}
                                      </FieldError>
                                    ) : null}
                                  </Field>
                                  <Field label={i18n.t('settlement.wages.status')}>
                                    <Select
                                      value={wage.status}
                                      disabled={wage.isHistorical}
                                      onChange={(event) =>
                                        updateWageItem(wage.id, {
                                          status: event.currentTarget
                                            .value as WageItemDraft['status'],
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
                                      aria-label={amountLabel}
                                      aria-invalid={amountProblem !== null || undefined}
                                      aria-describedby={amountProblem ? amountErrorId : undefined}
                                      formatError="none"
                                      className={
                                        amountProblem ? 'border-[var(--c-danger)]' : undefined
                                      }
                                      onBlur={() => touch(`${wage.id}:amount`)}
                                      onChange={(event) =>
                                        updateWageItem(wage.id, {
                                          amount: event.currentTarget.value,
                                          isHistorical: false,
                                        })
                                      }
                                    />
                                    {amountProblem ? (
                                      <FieldError id={amountErrorId}>
                                        {i18n.t(ITEM_MONEY_PROBLEM_MESSAGE[amountProblem], {
                                          field: amountLabel,
                                        })}
                                      </FieldError>
                                    ) : null}
                                  </Field>
                                </div>
                                <div className="mt-3">
                                  <Field label={i18n.t('settlement.wages.reason')}>
                                    {wage.isHistorical ? (
                                      <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-3)] px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
                                        {i18n.t('settlement.wages.historicalReason')}
                                      </p>
                                    ) : (
                                      <>
                                        <Textarea
                                          value={wage.reason}
                                          maxLength={500}
                                          aria-label={reasonLabel}
                                          placeholder={i18n.t('settlement.wages.reasonPlaceholder')}
                                          invalid={!valid && reasonMissing}
                                          aria-describedby={
                                            !valid && reasonMissing ? reasonErrorId : undefined
                                          }
                                          onBlur={() => touch(`${wage.id}:reason`)}
                                          onChange={(event) =>
                                            updateWageItem(wage.id, {
                                              reason: event.currentTarget.value,
                                              isHistorical: false,
                                            })
                                          }
                                        />
                                        {!valid && reasonMissing ? (
                                          <FieldError id={reasonErrorId}>
                                            {i18n.t('settlement.errors.itemReasonEmpty', {
                                              field: reasonLabel,
                                            })}
                                          </FieldError>
                                        ) : null}
                                      </>
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
                      {...revealFor('nextPurchaseReserve')}
                      onChange={(value) => setMoney('nextPurchaseReserve', value)}
                    />
                    <AmountField
                      label={i18n.t('settlement.field.priorPurchaseAdjustment')}
                      value={draft.priorPurchaseAdjustment}
                      signed
                      {...revealFor('priorPurchaseAdjustment')}
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
                      {...revealFor('cashOnHand')}
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
                      aria-label={i18n.t('settlement.field.note')}
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
                          setDraft((current) => ({
                            ...current,
                            correctionReason: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  ) : null}
                </CardBody>
              </Card>
            </fieldset>

            {/* A11Y-2: one summary that counts what to fix and goes there. */}
            {fieldsToFix > 0 && (invalidMoney || invalidDetails || !correctionReady) ? (
              <Banner
                tone="warn"
                title={i18n.t('settlement.errors.fieldsToFix', { n: fieldsToFix })}
                action={
                  <Button size="sm" variant="pearl" onClick={showFirstFieldToFix}>
                    {i18n.t('settlement.errors.goToFirst')}
                  </Button>
                }
              >
                {invalidMoney ? (
                  <span className="block">{i18n.t('settlement.errors.invalidMoney')}</span>
                ) : null}
                {invalidDetails ? (
                  <span className="block">{i18n.t('settlement.errors.invalidDetailsBody')}</span>
                ) : null}
              </Banner>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>{i18n.t('settlement.summary.title')}</CardTitle>
              </CardHeader>
              <CardBody>
                <SummaryRow
                  label={i18n.t('settlement.summary.totalRevenue')}
                  value={
                    summary.totalRevenue === null
                      ? null
                      : formatMoney(summary.totalRevenue, currency)
                  }
                />
                <SummaryRow
                  label={i18n.t('settlement.summary.paidOutflows')}
                  value={
                    summary.paidOutflows === null
                      ? null
                      : formatMoney(summary.paidOutflows, currency)
                  }
                />
                <SummaryRow
                  label={i18n.t('settlement.summary.futureCommitments')}
                  value={
                    summary.futureCommitments === null
                      ? null
                      : formatMoney(summary.futureCommitments, currency)
                  }
                />
                <SummaryRow
                  label={i18n.t('settlement.summary.priorPurchaseAdjustment')}
                  value={
                    summary.priorPurchaseAdjustment === null
                      ? null
                      : formatSignedMoney(summary.priorPurchaseAdjustment, currency)
                  }
                />
                <SummaryRow
                  label={i18n.t('settlement.summary.endingCash')}
                  value={
                    summary.endingCash === null ? null : formatMoney(summary.endingCash, currency)
                  }
                />
              </CardBody>
            </Card>
          </>
        )}

        <section className="flex flex-col gap-2">
          <SectionLabel as="h2">{i18n.t('settlement.recent.title')}</SectionLabel>
          {recentQuery.isPending ? (
            <PendingState query={recentQuery} />
          ) : recentQuery.isError && !recentQuery.data ? (
            // F11 (2026-10-30): a failed load read "no settlements yet".
            <QueryErrorBanner query={recentQuery} />
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
                        <span className="block text-old-h3 font-semibold tabular-nums text-[var(--c-fg)]">
                          {dates.calendarDay(record.date)}
                        </span>
                        <span className="mt-0.5 block text-old-body-sm text-[var(--c-fg-muted)]">
                          {i18n.t('settlement.recent.version', { version: record.version })}
                          {record.updatedByName
                            ? ` · ${i18n.t('settlement.recent.updatedBy', { name: record.updatedByName })}`
                            : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-old-label font-semibold text-[var(--c-action)]">
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
                <p className="text-old-body-sm text-[var(--c-fg-muted)]">
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
                  {roleText.name(role)}
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

          {wageRosterQuery.isPending ? <PendingState query={wageRosterQuery} /> : null}
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
            <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
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
                      <span className="block truncate text-old-body font-semibold text-[var(--c-fg)]">
                        {employee.displayName}
                      </span>
                      <span className="mt-0.5 block truncate text-old-label text-[var(--c-fg-muted)]">
                        {employee.roles.length > 0
                          ? employee.roles
                              .map((role) => roleText.name(role))
                              .join(i18n.t('common.listSeparator'))
                          : i18n.t('settlement.wages.noRole')}
                      </span>
                    </span>
                    <span className="shrink-0 text-old-label font-semibold text-[var(--c-action)]">
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

const HISTORY_FIELD_KEY: Record<string, string> = {
  onlineRevenue: 'settlement.field.onlineRevenue',
  invoicedCashRevenue: 'settlement.field.invoicedCashRevenue',
  operatingExpenses: 'settlement.field.operatingExpenses',
  wagesPaid: 'settlement.field.wagesPaid',
  wagesAccrued: 'settlement.field.wagesAccrued',
  nextPurchaseReserve: 'settlement.field.nextPurchaseReserve',
  priorPurchaseAdjustment: 'settlement.field.priorPurchaseAdjustment',
  cashOnHand: 'settlement.field.cashOnHand',
  note: 'settlement.field.note',
  operatingExpenseItems: 'settlement.expenses.title',
  wageItems: 'settlement.wages.title',
};

/**
 * CLS-20 (2026-10-30): every saved version of this day — who, when, what
 * changed, and why. The page only said "version N · updated by X".
 */
function SettlementHistory({ settlementId }: { settlementId: string }) {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const [open, setOpen] = useState(false);
  const history = trpc.settlement.revisions.useQuery({ settlementId }, { enabled: open });
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2.5 text-left text-old-body font-semibold text-[var(--c-fg)] ring-hairline"
      >
        {i18n.t('settlement.history.title')}
        <span aria-hidden className={'transition-transform ' + (open ? 'rotate-90' : '')}>
          ›
        </span>
      </button>
      {open ? (
        history.isPending ? (
          <LoadingState variant="compact" />
        ) : history.isError ? (
          <Banner tone="danger" title={i18n.t('settlement.errors.load')} />
        ) : (
          <ul className="flex flex-col gap-2" role="list">
            {(history.data ?? []).map((rev) => (
              <li
                key={rev.version}
                className="rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-2.5 ring-hairline"
              >
                <div className="text-old-body-sm font-semibold text-[var(--c-fg)]">
                  {i18n.t('settlement.recent.version', { version: rev.version })} ·{' '}
                  {dateFmt.dateTime(rev.createdAt)}
                  {rev.actorName ? ` · ${rev.actorName}` : ''}
                </div>
                {rev.version === 1 ? (
                  <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('settlement.history.created')}
                  </div>
                ) : rev.changedFields.length > 0 ? (
                  <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('settlement.history.changed', {
                      fields: rev.changedFields
                        .map((f) =>
                          HISTORY_FIELD_KEY[f]
                            ? i18n.t(HISTORY_FIELD_KEY[f] as Parameters<typeof i18n.t>[0])
                            : f,
                        )
                        .join(i18n.t('common.listSeparator')),
                    })}
                  </div>
                ) : null}
                {rev.correctionReason ? (
                  <div className="mt-0.5 whitespace-pre-wrap text-old-label text-[var(--c-fg)]">
                    {i18n.t('settlement.history.reason', { reason: rev.correctionReason })}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
