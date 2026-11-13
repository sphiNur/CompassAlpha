/**
 * The purchase sheet: the advanced per-item purchase editor (splits,
 * per-store pricing, receipt photo), for a new purchase, a correction of
 * one, or the extra a newly attached order asks for (DX-BUY-2).
 *
 * Props-driven, extracted from RunPage.tsx (Phase 4 step 3 of the 2026-07
 * frontend audit's run-domain split): the draft comes in, edits go out
 * through onChange, and RunPage holds the state. Review RUNWEB2-09
 * (2026-11-12): its own file; the quantity and price fields are the ones
 * the "+ add" sheet uses (QtyPriceFields).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Field,
  FieldLabel,
  Input,
  PhotoCapture,
  Select,
  Sheet,
  surfaceClass,
  useToast,
  type PhotoUploader,
} from '@compass/ui';
import { PaymentMethodChips } from '../../../components/PaymentMethodChips';
import { useCurrency } from '../../../hooks/useCurrency';
import { useDraftChanged } from '../../../hooks/useDraftChanged';
import { useI18n, useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney, formatQty } from '../../../lib/format';
import { fromDisplayPrice, shownPrice, toDisplayPrice } from '../lib/priceMath';
import { purchaseDraftCheck, purchaseDraftEdits } from '../lib/purchaseForm';
import { followPaymentMethod, followUnitPrice } from '../lib/purchaseOverrides';
import type { SkuLite, StoreLite } from '../types';
import type { PurchaseDraft } from './drafts';
import { QtyPriceFields } from './QtyPriceFields';
import { priceHint, qtyHint } from './saveHint';

interface PurchaseSheetProps {
  draft: PurchaseDraft | null;
  skuById: Map<string, SkuLite>;
  storeById: Map<string, StoreLite>;
  suppliers: Array<{ id: string; name: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  photoUploader: PhotoUploader | undefined;
  /** M3.36: when true, display + accept price in thousands. Draft
   *  always stores raw UZS — only the visible input value is divided. */
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  onCancel: () => void;
  onChange: (d: PurchaseDraft | null) => void;
  onSubmit: (d: PurchaseDraft) => void;
  submitting: boolean;
  /** Undo this purchase entirely. Edit mode only; the caller routes it
   *  through the page's ConfirmSheet. Absent on a fresh purchase, where
   *  there is nothing yet to undo. */
  onUndo?: () => void;
}

export function PurchaseSheet({
  draft,
  skuById,
  storeById,
  suppliers,
  productName,
  photoUploader,
  priceInThousands,
  onTogglePriceUnit,
  onCancel,
  onChange,
  onSubmit,
  submitting,
  onUndo,
}: PurchaseSheetProps) {
  const i18n = useI18n();
  const toast = useToast();
  const currency = useCurrency();
  const unitLabel = useUnitLabel();
  const sku = draft ? skuById.get(draft.skuId) : null;
  const candidateStores = useMemo(() => [...storeById.values()], [storeById]);
  // CMP-BUY-4: what the buyer typed is not dropped by Esc / backdrop / back.
  // RUNWEB2-07: the stores' quantities, prices and methods count too.
  const changed = useDraftChanged(draft, (d) => `${d.skuId}:${d.isEdit}`, purchaseDraftEdits);

  // M3.36: local display state for the price input. Decoupled from
  // draft.unitPrice (which always holds raw UZS) so intermediate
  // typing states like "147." don't get round-tripped through
  // String(Number()) and lose the trailing decimal. Resynced when
  // the sheet opens on a different row or the mode flips.
  const [priceInput, setPriceInput] = useState<string>('');
  // Review RUNWEB2-01: the per-store price fields keep their typed text
  // the same way (see shownPrice), per store, reset with the main one.
  const typedSplitPrice = useRef(new Map<string, string>());
  useEffect(() => {
    typedSplitPrice.current.clear();
    if (!draft) {
      setPriceInput('');
      return;
    }
    setPriceInput(toDisplayPrice(draft.unitPrice, priceInThousands));
    // Intentionally exclude draft.unitPrice — we only want to resync on
    // row open / mode flip, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.skuId, draft?.isEdit, priceInThousands]);

  // If exactly one store has a value, mirror actualQty into it on change.
  useEffect(() => {
    if (!draft) return;
    if (draft.splits.size !== 1) return;
    const entries = [...draft.splits.entries()];
    const [storeId, qty] = entries[0]!;
    if (qty !== draft.actualQty) {
      const next = new Map(draft.splits);
      next.set(storeId, draft.actualQty);
      onChange({ ...draft, splits: next });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.actualQty]);

  // RUNWEB2-04: the one rule (runs/lib/purchaseForm.ts).
  const { splitTotal, splitMatches, reasonOk, canSubmit, blockedBy } = draft
    ? purchaseDraftCheck(draft)
    : {
        splitTotal: 0,
        splitMatches: false,
        reasonOk: true,
        canSubmit: false,
        blockedBy: null,
      };
  // UX-05: what else the disabled Save waits for (a split that does not
  // add up and a missing reason are on the button itself).
  const saveHint = !draft
    ? ''
    : blockedBy === 'qty'
      ? qtyHint(i18n.t, draft.actualQty)
      : blockedBy === 'price'
        ? priceHint(i18n.t, priceInput, currency)
        : blockedBy === 'storePrice'
          ? i18n.t('run.errors.priceFormat')
          : '';

  // M3.49 (2026-05-23): the sheet's own footer button is now ALWAYS
  // rendered — the in-page PageMainButton is hidden behind the sheet
  // when one opens, so each sheet must own its primary CTA.
  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && onCancel()}
      hasChanges={changed && !submitting}
      title={
        draft?.topUp
          ? i18n.t('run.topUp.buy')
          : draft?.isEdit
            ? i18n.t('run.confirm.editPurchase.title')
            : i18n.t('run.action.recordPurchase')
      }
      description={sku ? productName(sku) : ''}
      footer={
        // M3.49: see Shell's PageMainButton — sheet footers always render now.
        <Button
          block
          loading={submitting}
          disabled={!canSubmit}
          disabledHint={saveHint}
          onClick={() =>
            draft &&
            (canSubmit ? onSubmit(draft) : toast.error(i18n.t('run.errors.splitSumMismatch')))
          }
        >
          {!splitMatches
            ? i18n.t('run.label.splitsMismatch', {
                sum: formatQty(splitTotal),
                target: formatQty(draft?.actualQty || '0'),
              })
            : !reasonOk
              ? i18n.t('run.errors.reviseReasonRequired')
              : draft?.isEdit
                ? i18n.t('run.action.editPurchase')
                : i18n.t('run.action.savePurchase')}
        </Button>
      }
    >
      {draft ? (
        <div className="flex flex-col gap-3 py-3">
          {draft.topUp ? (
            // DX-BUY-2: the earlier batch stays as it was bought.
            <Banner tone="info">
              {i18n.t('run.topUp.sheetBody', {
                qty: `${formatQty(
                  draft.topUp.base.reduce((sum, b) => sum + Number(b.qty), 0),
                )} ${sku ? unitLabel.uncounted(sku.unit) : ''}`.trim(),
                price: `${formatMoney(draft.topUp.item.unitPrice)} ${currency}`,
              })}
            </Banner>
          ) : draft.isEdit ? (
            <Banner
              tone="info"
              title={i18n.t(
                draft.qtyLocked ? 'run.prices.lockedHint' : 'run.confirm.editPurchase.body',
              )}
            />
          ) : null}
          <QtyPriceFields
            qtyUnit={sku?.unit ? unitLabel.uncounted(sku.unit) : undefined}
            qty={draft.actualQty}
            onQty={(actualQty) => onChange({ ...draft, actualQty })}
            qtyLocked={draft.qtyLocked}
            autoFocusQty={!draft.qtyLocked}
            priceText={priceInput}
            onPriceText={(v) => {
              setPriceInput(v);
              // M3.36: draft always stores raw UZS — multiply back when
              // committing. The display state is the source of truth for
              // what's shown.
              const unitPrice = fromDisplayPrice(v, priceInThousands);
              onChange({
                ...draft,
                unitPrice,
                // 2026-10-25: stores on the old price follow the new one.
                ...(draft.perStorePricing
                  ? { splitPrices: followUnitPrice(draft.splitPrices, draft.unitPrice, unitPrice) }
                  : {}),
              });
            }}
            priceUnit={sku?.unit ? unitLabel.uncounted(sku.unit) : undefined}
            priceInThousands={priceInThousands}
            onTogglePriceUnit={onTogglePriceUnit}
          />
          {/* M1.14: payment method picker. Two-segment chip group so
              both options are always visible — radio behaviour without
              the OS-styled radio buttons. */}
          <div>
            <FieldLabel className="mb-1">{i18n.t('run.label.paymentMethod')}</FieldLabel>
            <PaymentMethodChips
              value={draft.paymentMethod}
              onChange={(m) =>
                onChange({
                  ...draft,
                  paymentMethod: m,
                  // 2026-10-25: stores paying the old method follow the new
                  // one (lib/purchaseOverrides); a store used to keep
                  // "cash" while the line said "transfer".
                  ...(draft.perStorePricing
                    ? {
                        splitPaymentMethods: followPaymentMethod(
                          draft.splitPaymentMethods,
                          draft.paymentMethod,
                          m,
                        ),
                      }
                    : {}),
                })
              }
            />
          </div>
          {/* RUNWEB2-23: the kit's button (was a hand-made pill). */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (!draft.perStorePricing) {
                const splitPrices = new Map(draft.splitPrices);
                const splitPaymentMethods = new Map(draft.splitPaymentMethods);
                for (const storeId of draft.splits.keys()) {
                  if (!splitPrices.has(storeId)) splitPrices.set(storeId, draft.unitPrice);
                  if (!splitPaymentMethods.has(storeId)) {
                    splitPaymentMethods.set(storeId, draft.paymentMethod);
                  }
                }
                onChange({
                  ...draft,
                  splitPrices,
                  splitPaymentMethods,
                  perStorePricing: true,
                });
              } else {
                onChange({ ...draft, perStorePricing: false });
              }
            }}
          >
            {/* 2026-07-26: both labels were hard-coded Chinese. */}
            {draft.perStorePricing
              ? i18n.t('run.purchase.pricingUniform')
              : i18n.t('run.purchase.pricingPerStore')}
          </Button>
          {suppliers.length > 0 ? (
            <Field label={i18n.t('run.action.supplier')}>
              <Select
                value={draft.supplierId ?? ''}
                onChange={(e) => onChange({ ...draft, supplierId: e.target.value || null })}
              >
                {/* RUNWEB2-32: read out as words, not "dash". */}
                <option value="">{i18n.t('run.action.supplierNone')}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <PhotoCapture
            label={i18n.t('run.action.receiptPhoto')}
            value={draft.receiptPhotoUrl}
            onCapture={(url) => onChange({ ...draft, receiptPhotoUrl: url })}
            onClear={() => onChange({ ...draft, receiptPhotoUrl: null })}
            uploader={photoUploader}
          />
          <div>
            <div className="mb-2 flex items-center justify-between">
              <FieldLabel>{i18n.t('run.action.allocateAcrossStores')}</FieldLabel>
              <span
                className={`text-old-label tabular-nums ${
                  splitMatches ? 'text-[var(--c-success)]' : 'text-[var(--c-warning-fg)]'
                }`}
              >
                {/* Walkthrough F7 (2026-11-05): an unreadable qty was echoed here
                    as typed ("12a" / "abc"); show a dash until it is a number. */}
                {formatQty(splitTotal)} /{' '}
                {Number.isFinite(Number(draft.actualQty || '0'))
                  ? formatQty(draft.actualQty || '0')
                  : '—'}
              </span>
            </div>
            {/* RUNWEB2-22: one list with dividers (UI-6), not a card per store. */}
            <ul className={`flex flex-col ${surfaceClass}`}>
              {candidateStores.map((store) => {
                const splitQty = draft.splits.get(store.id) ?? '';
                return (
                  <li
                    key={store.id}
                    className="border-b border-[var(--c-divider)] p-2 last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-old-body">{store.name}</span>
                      <Input
                        type="number"
                        value={splitQty}
                        disabled={draft.qtyLocked}
                        // DX-IX-8 (2026-11-01): was read out as "edit text".
                        aria-label={i18n.t('run.alloc.qtyFor', { store: store.name })}
                        onChange={(e) => {
                          const next = new Map(draft.splits);
                          if (e.target.value === '') next.delete(store.id);
                          else next.set(store.id, e.target.value);
                          onChange({ ...draft, splits: next });
                        }}
                        className="w-24 text-right"
                      />
                    </div>
                    {draft.perStorePricing && Number(splitQty) > 0 ? (
                      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          aria-label={i18n.t('run.alloc.priceFor', { store: store.name })}
                          value={shownPrice(
                            draft.splitPrices.get(store.id) ?? draft.unitPrice,
                            typedSplitPrice.current.get(store.id),
                            priceInThousands,
                          )}
                          onChange={(e) => {
                            typedSplitPrice.current.set(store.id, e.target.value);
                            const next = new Map(draft.splitPrices);
                            next.set(store.id, fromDisplayPrice(e.target.value, priceInThousands));
                            onChange({ ...draft, splitPrices: next });
                          }}
                          className="text-right"
                        />
                        {/* DX-VIS-6 / DX-VIS-7 (2026-11-01): was a hand-rolled
                            pair of 31px buttons, selected by colour only.
                            RUNWEB2-23: the same picker as the line's, smaller. */}
                        <PaymentMethodChips
                          size="sm"
                          equalWidth={false}
                          value={draft.splitPaymentMethods.get(store.id) ?? draft.paymentMethod}
                          onChange={(method) => {
                            const next = new Map(draft.splitPaymentMethods);
                            next.set(store.id, method);
                            onChange({ ...draft, splitPaymentMethods: next });
                          }}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
          {draft.isEdit ? (
            <Field label={i18n.t('run.label.reasonForChange')}>
              <Input
                value={draft.reason}
                onChange={(e) => onChange({ ...draft, reason: e.target.value })}
                placeholder={i18n.t('run.label.reasonPlaceholder')}
              />
            </Field>
          ) : null}
          {/* Undo lives here now.
              It used to be a 20px text button on the purchased row,
              immediately beside the row's other controls — a destructive
              action one row-pitch from a money-committing one. Moving it
              inside the edit sheet keeps it reachable (tap the row →
              here) and puts deliberate distance between it and the ✓.
              It still routes through RunPage's ConfirmSheet. */}
          {draft.isEdit && onUndo && !draft.qtyLocked ? (
            // DX-VIS-6 (2026-11-01): a 31px hand-rolled text button; the
            // kit's soft-danger button is 44px to tap and reads as one.
            <Button block size="sm" variant="danger-ghost" onClick={onUndo}>
              {i18n.t('run.action.undoPurchase')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
