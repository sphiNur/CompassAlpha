/**
 * SettlementPage — one store's end-of-day cash close.
 *
 * A daily close is deliberately a small, explicit record rather than a
 * calculated sales report: the cashier records what happened and the API
 * keeps a versioned correction trail.  This screen therefore never infers
 * cash from other modules or silently overwrites an existing close.
 *
 * Review CONF-06: the form's state and rules are `useSettlementForm`; the
 * parts are in `./settlement/`.
 */
import { useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardMeta,
  Disclosure,
  EmptyState,
  Field,
  Input,
  LoadingState,
  PendingState,
  SectionLabel,
  Select,
  Textarea,
} from '@compass/ui';
import { BACKDATE_LIMIT_DAYS } from '@compass/contracts/limits';
import { NoStoreYet, useNoStoreYet } from '../components/NoStoreYet';
import { usePageMainButton } from '../hooks/useTelegram';
import { useI18n } from '../hooks/useI18n';
import { zoneName } from '../lib/dateFormat';
import { StoreSalesPanel } from '../components/sales/StoreSalesPanel';
import { hasStorePermission } from '../lib/storePermission';
import { BUSINESS_DATE } from './settlement/draftModel';
import { AmountField } from './settlement/AmountField';
import { ExpenseLines } from './settlement/ExpenseLines';
import { RecentCloses } from './settlement/RecentCloses';
import { SettlementHistory } from './settlement/SettlementHistory';
import { SettlementSummary } from './settlement/SettlementSummary';
import { WageLines } from './settlement/WageLines';
import { useSettlementForm } from './settlement/useSettlementForm';

/**
 * The page while there is no form to show yet. UI-12 (2026-11-05): a tab
 * page carries no visible title — the bottom nav names it (Order, Review,
 * Run, Receive, History already work this way). The Shell's hidden <h1>
 * keeps the heading for screen readers.
 */
function PageFrame({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 px-4 pb-4 pt-3">{children}</div>;
}

export function SettlementPage() {
  const i18n = useI18n();
  const noStoreYet = useNoStoreYet();
  const {
    session,
    storesQuery,
    eligibleStores,
    currentStoreId,
    requestedStoreId,
    chooseStore,
    currency,
    businessDateQuery,
    businessDate,
    date,
    dateValid,
    chooseDate,
    openDay,
    closeQuery,
    existing,
    draft,
    edit,
    restoredDraft,
    discardRestoredDraft,
    totals,
    summary,
    invalidMoney,
    invalidDetails,
    wageSelectionRequired,
    needsCorrectionReason,
    correctionReady,
    hasUnsavedChanges,
    draftSynchronized,
    tooOldForNew,
    versionConflict,
    canSave,
    fieldsToFix,
    formRef,
    reveal,
    revealFor,
    showFirstFieldToFix,
    saving,
    save,
    refreshRecord,
  } = useSettlementForm();
  // 2026-10-21 CA-09: sales entry block (see render). Review CONF-14: as
  // sales.record holds in this store, overrides included.
  const canRecordSales = hasStorePermission(session, currentStoreId, 'sales.record');
  const [salesOpen, setSalesOpen] = useState(false);

  const mainButtonText = saving
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
    active: canSave && !saving,
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
        onChange={(event) => chooseDate(event.target.value)}
      />
    </Field>
  ) : null;
  const storeSelector =
    eligibleStores.length > 1 && currentStoreId ? (
      <Field label={i18n.t('settlement.store.label')}>
        <Select
          value={currentStoreId}
          aria-label={i18n.t('settlement.store.label')}
          onChange={(event) => chooseStore(event.target.value)}
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
      <PageFrame>
        <PendingState query={storesQuery} variant="block" />
      </PageFrame>
    );
  }

  if (storesQuery.isError) {
    return (
      <PageFrame>
        <Banner
          tone="danger"
          title={i18n.t('settlement.errors.stores')}
          action={
            <Button size="sm" variant="pearl" onClick={() => void storesQuery.refetch()}>
              {i18n.t('settlement.action.refresh')}
            </Button>
          }
        />
      </PageFrame>
    );
  }

  if (!currentStoreId) {
    return (
      <PageFrame>
        {noStoreYet ? (
          <NoStoreYet />
        ) : (
          <EmptyState
            title={i18n.t('settlement.noEligibleStores.title')}
            description={i18n.t('settlement.noEligibleStores.body')}
          />
        )}
      </PageFrame>
    );
  }

  // Do not render Store A's form under Store B's shell label even for the
  // single paint before the synchronization effect updates global context.
  if (currentStoreId !== requestedStoreId) {
    return (
      <PageFrame>
        <LoadingState />
      </PageFrame>
    );
  }

  if (!businessDate) {
    return (
      <PageFrame>
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
      </PageFrame>
    );
  }

  // Query caches can resolve a different store/date before the draft-reset
  // effect runs. Do not briefly render any prior form under this context, and
  // do not offer an empty form while the selected close is still loading.
  // CLS-4 (2026-10-30): a future or cleared date disables the close query,
  // and a disabled query stays `isPending`, so this page spun forever with
  // the date field gone. Keep the field and say what is wrong instead.
  if (!dateValid) {
    return (
      <PageFrame>
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
      </PageFrame>
    );
  }

  if (!draftSynchronized) {
    return (
      <PageFrame>
        {storeSelector}
        {/* CONF-02: offline with no saved copy of this day, say so; a
            bare spinner turned until the network came back. */}
        <PendingState query={closeQuery} variant="block" />
      </PageFrame>
    );
  }

  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex flex-col gap-3 px-4 pt-3">
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
          // CONF-11: the kit's Disclosure; the open state stays here, as the
          // form is drawn again from scratch when the day or store changes.
          <Disclosure
            title={i18n.t('sales.list.title')}
            open={salesOpen}
            onOpenChange={setSalesOpen}
          >
            <StoreSalesPanel key={currentStoreId} storeId={currentStoreId} />
          </Disclosure>
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
            <fieldset ref={formRef} disabled={saving} aria-busy={saving} className="contents">
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
                        onChange={(value) => edit.money('onlineRevenue', value)}
                      />
                      <AmountField
                        label={i18n.t('settlement.field.invoicedCashRevenue')}
                        value={draft.invoicedCashRevenue}
                        {...revealFor('invoicedCashRevenue')}
                        onChange={(value) => edit.money('invoicedCashRevenue', value)}
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

                    <ExpenseLines
                      lines={draft.operatingExpenseItems}
                      update={edit.expenses}
                      total={totals.expenses.value}
                      currency={currency}
                      confirmRemoval={!!existing}
                      reveal={reveal}
                    />

                    <div className="border-t border-[var(--c-divider)]" />

                    <WageLines
                      lines={draft.wageItems}
                      update={edit.wages}
                      storeId={currentStoreId}
                      date={date}
                      selectionRequired={wageSelectionRequired}
                      paidTotal={totals.paidWages.value}
                      unpaidTotal={totals.unpaidWages.value}
                      currency={currency}
                      confirmRemoval={!!existing}
                      reveal={reveal}
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
                      {...revealFor('nextPurchaseReserve')}
                      onChange={(value) => edit.money('nextPurchaseReserve', value)}
                    />
                    <AmountField
                      label={i18n.t('settlement.field.priorPurchaseAdjustment')}
                      value={draft.priorPurchaseAdjustment}
                      signed
                      {...revealFor('priorPurchaseAdjustment')}
                      onChange={(value) => edit.money('priorPurchaseAdjustment', value)}
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
                      onChange={(value) => edit.money('cashOnHand', value)}
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
                      onChange={(event) => edit.note(event.target.value)}
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
                        onChange={(event) => edit.correctionReason(event.target.value)}
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

            <SettlementSummary summary={summary} currency={currency} />
          </>
        )}

        <RecentCloses storeId={currentStoreId} onOpen={openDay} />
      </div>
    </div>
  );
}
