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
  SectionLabel,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useStoreContext } from '../components/StoreSwitcher';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { useI18n } from '../hooks/useI18n';
import { formatMoney, currencyOf } from '../lib/format';
import { useAuthStore } from '../stores/authStore';

type MoneyField =
  | 'onlineRevenue'
  | 'invoicedCashRevenue'
  | 'operatingExpenses'
  | 'wagesPaid'
  | 'wagesAccrued'
  | 'nextPurchaseReserve'
  | 'priorPurchaseAdjustment'
  | 'cashOnHand';

type SettlementRecord = Record<MoneyField, string> & {
  id: string;
  storeId: string;
  date: string;
  note: string | null;
  version: number;
  updatedByName: string | null;
  updatedAt: string;
};

type SettlementDraft = Record<MoneyField, string> & {
  note: string;
  correctionReason: string;
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

const POSITIVE_MONEY = /^\d{1,12}(?:\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?\d{1,12}(?:\.\d{1,2})?$/;
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
  };
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
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return raw;
  const absolute = Math.abs(parsed).toFixed(2);
  return parsed < 0 && absolute !== '0.00' ? `-${absolute}` : absolute;
}

function isMoney(value: string, signed = false): boolean {
  const expression = signed ? SIGNED_MONEY : POSITIVE_MONEY;
  if (!expression.test(value.trim())) return false;
  return Math.abs(Number(value)) <= 999_999_999_999.99;
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
  const [versionConflict, setVersionConflict] = useState(false);
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

  // A date switch can briefly retain a previous query result. Only ever use
  // a response for the date currently shown in the form.
  const existing =
    closeQuery.data && closeQuery.data.date === date ? (closeQuery.data as SettlementRecord) : null;
  const recordKey = `${currentStoreId ?? ''}:${date}:${existing?.id ?? 'new'}:${existing?.version ?? 0}`;

  useEffect(() => {
    if (!currentStoreId) return;
    setDraft(existing ? draftFromRecord(existing) : emptyDraft());
    setVersionConflict(false);
  }, [currentStoreId, recordKey]);

  const invalidMoney = MONEY_FIELDS.some(
    (field) => isMoney(draft[field], field === 'priorPurchaseAdjustment') === false,
  );
  const hasChanges = useMemo(() => {
    if (!existing) return true;
    return (
      MONEY_FIELDS.some(
        (field) => normalizedMoney(draft[field]) !== normalizedMoney(existing[field]),
      ) || draft.note.trim() !== (existing.note ?? '').trim()
    );
  }, [draft, existing]);
  const needsCorrectionReason = !!existing && hasChanges;
  const correctionReady = !needsCorrectionReason || draft.correctionReason.trim().length > 0;
  const dateValid = !!businessDate && BUSINESS_DATE.test(date) && date <= businessDate.date;
  const canSave =
    !!currentStoreId &&
    dateValid &&
    !invalidMoney &&
    hasChanges &&
    correctionReady &&
    !versionConflict &&
    !closeQuery.isFetching &&
    !closeQuery.isError;

  const onlineRevenue = moneyNumber(draft.onlineRevenue);
  const invoicedCashRevenue = moneyNumber(draft.invoicedCashRevenue);
  const operatingExpenses = moneyNumber(draft.operatingExpenses);
  const wagesPaid = moneyNumber(draft.wagesPaid);
  const wagesAccrued = moneyNumber(draft.wagesAccrued);
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
      setDraft(draftFromRecord(saved as SettlementRecord));
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
    saveMutation.mutate({
      storeId: currentStoreId,
      date,
      onlineRevenue: draft.onlineRevenue.trim(),
      invoicedCashRevenue: draft.invoicedCashRevenue.trim(),
      operatingExpenses: draft.operatingExpenses.trim(),
      wagesPaid: draft.wagesPaid.trim(),
      wagesAccrued: draft.wagesAccrued.trim(),
      nextPurchaseReserve: draft.nextPurchaseReserve.trim(),
      priorPurchaseAdjustment: draft.priorPurchaseAdjustment.trim(),
      cashOnHand: draft.cashOnHand.trim(),
      note: draft.note.trim() || null,
      correctionReason: needsCorrectionReason ? draft.correctionReason.trim() : null,
      expectedVersion: existing?.version ?? 0,
    });
  };

  const refreshRecord = () => {
    setVersionConflict(false);
    void closeQuery.refetch();
    void recentQuery.refetch();
  };

  const mainButtonText = saveMutation.isPending
    ? i18n.t('settlement.save.saving')
    : existing
      ? i18n.t('settlement.save.update')
      : i18n.t('settlement.save.new');
  usePageMainButton(mainButtonText, save, {
    visible: !!currentStoreId && currentStoreId === requestedStoreId && !!businessDate,
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
          onChange={(event) => setCurrentStore(event.target.value)}
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

  const setMoney = (field: MoneyField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
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
            onChange={(event) => setDate(event.target.value)}
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
            <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <AmountField
                label={i18n.t('settlement.field.operatingExpenses')}
                value={draft.operatingExpenses}
                onChange={(value) => setMoney('operatingExpenses', value)}
              />
              <AmountField
                label={i18n.t('settlement.field.wagesPaid')}
                value={draft.wagesPaid}
                onChange={(value) => setMoney('wagesPaid', value)}
              />
              <AmountField
                label={i18n.t('settlement.field.wagesAccrued')}
                value={draft.wagesAccrued}
                onChange={(value) => setMoney('wagesAccrued', value)}
              />
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
                        haptic('light');
                        setDate(record.date);
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
    </div>
  );
}
