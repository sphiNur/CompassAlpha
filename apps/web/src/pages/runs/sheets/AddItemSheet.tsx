/**
 * M3.41 (2026-05-21): mid-run "+ add item" sheet. Lets the purchaser
 * record a buy for a SKU that wasn't on the original aggregated order
 * (impromptu bazaar pickup, chef-call-in top-up, vendor freebie, …).
 *
 * Workflow inside the sheet:
 *   1. Search the SKU catalog. Tap a result → that SKU is selected.
 *   2. Pick the destination store (chips of stores already in the
 *      run — server rejects stores not in scope, the chip filter
 *      mirrors that constraint).
 *   3. Enter qty + price (price input respects the K-thousands toggle
 *      from page level). Live total hint below.
 *   4. A reason (required — audit log answers "why was this added
 *      beyond the original order?"). R8 (2026-11-13): the sheet opens
 *      with a default one filled in, so saving needs no typing.
 *   5. Save → server emits PurchaserItemAdded → row appears in the
 *      run with the "+" badge.
 *
 * Constraints handled by this UI (server enforces too):
 *   - SKU not already in the run (filtered out of the search list).
 *   - Destination store must already be in the run's scope.
 *   - reason is non-empty before Save is enabled.
 *
 * Multi-store split deferred to v2: v1 is single-store. Most impromptu
 * additions are "give me X for store A specifically" — multi-store
 * adds for the same SKU can be done by re-opening the sheet.
 *
 * Review RUNWEB2-09 (2026-11-12): each mode's parts are their own files
 * (SkuPicker and SkuStoreFields; ExpenseIdentity and ExpenseStoreFields),
 * and the quantity and price fields are the purchase sheet's
 * (QtyPriceFields). This keeps what both modes share.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Field,
  FieldLabel,
  Input,
  PhotoCapture,
  Segmented,
  Sheet,
  type PhotoUploader,
} from '@compass/ui';
import { lineAmountNumber } from '@compass/contracts/money';
import { PaymentMethodChips } from '../../../components/PaymentMethodChips';
import { useCurrency } from '../../../hooks/useCurrency';
import { useDraftChanged } from '../../../hooks/useDraftChanged';
import { useI18n, useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney } from '../../../lib/format';
import {
  fromDisplayPrice,
  isStorablePrice,
  readDisplayPrice,
  toDisplayPrice,
} from '../lib/priceMath';
import { addItemDraftEdits, splitsAddUp } from '../lib/purchaseForm';
import { evenSplitQty } from '../lib/splitQty';
import type { StoreLite } from '../types';
import type { AddItemDraft, AddItemSku, ExistingSkuStores, ExpenseTemplate } from './drafts';
import { ExpenseIdentity } from './ExpenseIdentity';
import { ExpenseStoreFields } from './ExpenseStoreFields';
import { QtyPriceFields } from './QtyPriceFields';
import { SkuPicker } from './SkuPicker';
import { SkuStoreFields } from './SkuStoreFields';

export function AddItemSheet({
  draft,
  runStoreIds,
  existingStoreIdsBySku,
  skus,
  expenseTemplates,
  storeById,
  productName,
  photoUploader,
  priceInThousands,
  onTogglePriceUnit,
  onCancel,
  onChange,
  onSubmit,
  submitting,
}: {
  draft: AddItemDraft | null;
  /** Stores already involved in this run — only these are eligible. */
  runStoreIds: string[];
  /**
   * M3.54 (2026-05-23): for each SKU already in the run, which storeIds
   * have demand AND the item's current status. Drives:
   *   - the SKU picker filter (an in-run SKU is shown iff at least one
   *     run-store still has NO demand for it — i.e., "room" to add)
   *   - the store dropdown filter when an in-run SKU is selected
   *     (those stores are hidden — they'd be a true conflict)
   *   - the "augment existing item" hint that warns the user the
   *     additional demand will route through purchaseItem/revisePurchase
   *     instead of creating a fresh added-by-purchaser row.
   *
   * Without this, the previous code blocked the SKU outright, so a
   * scenario like "A ordered H, B suddenly needs H" left the
   * purchaser unable to add for B at all — see the user-reported
   * cross-store interference bug.
   */
  existingStoreIdsBySku: ExistingSkuStores;
  skus: AddItemSku[];
  expenseTemplates: ExpenseTemplate[];
  storeById: Map<string, StoreLite>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  /** M3.44: uploads the receipt photo, offered for an expense or a product
   *  recorded as its own cost. Always optional (see 2026-07-06 below). */
  photoUploader: PhotoUploader | undefined;
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  onCancel: () => void;
  onChange: (d: AddItemDraft | null) => void;
  onSubmit: (d: AddItemDraft) => void;
  submitting: boolean;
}) {
  const i18n = useI18n();
  const currency = useCurrency();
  const unitLabel = useUnitLabel();
  const [search, setSearch] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const initializedExpenseScopeRef = useRef<string | null>(null);
  // RUNWEB2-07: the payment method, scope, cost mode and store count too.
  const changed = useDraftChanged(draft, (d) => `${d.mode}:${d.expenseId}`, addItemDraftEdits);

  // Reset local input states when the sheet opens/closes for a new draft.
  useEffect(() => {
    if (!draft) {
      setSearch('');
      setPriceInput('');
      return;
    }
    setPriceInput(toDisplayPrice(draft.unitPrice, priceInThousands));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.runId, draft?.skuId, draft?.mode, priceInThousands]);

  const selectedSku = useMemo(
    () => (draft?.skuId ? skus.find((s) => s.id === draft.skuId) : null),
    [draft?.skuId, skus],
  );

  // Existing storeIds for the picked SKU (if any). Drives cost-mode hints
  // and marks store choices that should be recorded as independent costs.
  const selectedSkuExisting = useMemo(() => {
    if (!draft?.skuId) return null;
    return existingStoreIdsBySku.get(draft.skuId) ?? null;
  }, [draft?.skuId, existingStoreIdsBySku]);

  // Single-store v1: dropdown of run-involved stores. Existing store/SKU
  // combinations remain visible; selecting one routes the entry to an
  // expense row so the original purchase item is not rewritten.
  const storeChoices = useMemo(() => {
    const all = runStoreIds.map((id) => storeById.get(id)).filter((s): s is StoreLite => !!s);
    return all;
  }, [runStoreIds, storeById]);
  const selectedStoreId = draft && draft.splits.size === 1 ? [...draft.splits.keys()][0]! : '';
  const selectedStoreAlreadyHasSku =
    !!selectedStoreId && !!selectedSkuExisting?.storeIds.has(selectedStoreId);
  const skuRecordsAsExpense =
    draft?.mode === 'sku' &&
    !!selectedSkuExisting &&
    (draft.skuCostMode === 'separateExpense' || selectedStoreAlreadyHasSku);

  // D1: the line as the server counts it — rounded half-up to cents.
  const totalHint = useMemo(() => {
    if (!draft) return null;
    const qty = draft.actualQty.trim();
    const raw = readDisplayPrice(priceInput, priceInThousands);
    if (!/^\d+(\.\d+)?$/.test(qty) || Number(qty) <= 0 || raw === null) return null;
    return lineAmountNumber(qty, raw);
  }, [draft, priceInput, priceInThousands]);

  // 2026-07-06: the >200,000 UZS "receipt photo required" gate on
  // expenses was removed. Every expense already carries a mandatory
  // reason (the real audit trail); blocking a bazaar purchase because
  // no paper receipt is available was the wrong trade. The photo stays
  // available but optional.

  // The store quantities add up to the quantity, by the server's measure
  // (lib/purchaseForm.ts). An even split does exactly: evenSplitQty gives
  // the last store the remainder.
  const splitMatches = !!draft && splitsAddUp(draft.splits, draft.actualQty).splitMatches;

  const canSubmit = !!(
    draft &&
    (draft.mode === 'sku' ? draft.skuId : draft.label.trim().length > 0) &&
    Number(draft.actualQty) > 0 &&
    isStorablePrice(draft.unitPrice) &&
    draft.splits.size > 0 &&
    splitMatches &&
    draft.reason.trim().length > 0 &&
    !submitting
  );

  // M3.44: an expense's quantity is split evenly across the stores picked,
  // to three decimals, the last store taking the remainder, so the parts
  // add up exactly (evenSplitQty). E.g. 1 / 3 = 0.333, 0.333, 0.334.
  //
  // M3.51 (2026-05-23): when qty hasn't been entered yet, every selected
  // store is STILL registered in the map (with empty values). Without
  // this, tapping a store chip before typing qty produced an empty map →
  // splits.size stayed 0 → the qty input row was gated on splits.size > 0,
  // so it never appeared → user got stuck unable to add a single-store
  // expense (or multi-store expense from a fresh sheet). The "stub"
  // entries get overwritten by the qty input's onChange handler the
  // moment the user types.

  // A new expense begins as a shared daily cost. Initialise its store split
  // once, but leave deliberate later chip edits alone.
  useEffect(() => {
    if (
      !draft ||
      draft.mode !== 'expense' ||
      draft.expenseScope !== 'shared' ||
      draft.splits.size > 0 ||
      storeChoices.length === 0 ||
      initializedExpenseScopeRef.current === draft.expenseId
    ) {
      return;
    }
    initializedExpenseScopeRef.current = draft.expenseId;
    onChange({
      ...draft,
      splits: evenSplitQty(
        storeChoices.map((store) => store.id),
        draft.actualQty,
      ),
    });
  }, [draft, onChange, storeChoices]);

  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && onCancel()}
      // CMP-BUY-4: an expense or item being typed asks before it is lost.
      hasChanges={changed && !submitting}
      title={
        draft?.mode === 'expense'
          ? i18n.t('run.action.addExpense.title')
          : i18n.t('run.action.addItem.title')
      }
      description={
        draft?.mode === 'sku' && selectedSku
          ? productName(selectedSku)
          : draft?.mode === 'expense'
            ? i18n.t('run.action.addExpense.subtitle')
            : i18n.t('run.action.addItem.subtitle')
      }
      footer={
        <Button
          block
          loading={submitting}
          disabled={!canSubmit}
          onClick={() => draft && canSubmit && onSubmit(draft)}
        >
          {draft?.mode === 'expense'
            ? i18n.t('run.action.addExpense.save')
            : i18n.t('run.action.addItem.save')}
        </Button>
      }
    >
      {draft ? (
        <div className="flex flex-col gap-3 py-3">
          {/* M3.44: mode tabs at the top. Tapping switches the form
              shape; the shared fields (qty / price / payment / reason)
              stay populated so a mistaken-mode tap doesn't wipe what
              the user typed. */}
          {/* DX-VIS-7 (2026-11-01): Segmented, so the selected mode is
              announced, not only coloured. */}
          <Segmented
            value={draft.mode}
            onChange={(m) => {
              // Mode switch: clear identity-specific fields
              // (skuId / label) and reset splits because the
              // store-selection UI is different across modes.
              onChange({
                ...draft,
                mode: m,
                skuId: m === 'sku' ? null : draft.skuId,
                skuCostMode: 'merge',
                label: m === 'expense' ? '' : draft.label,
                splits: new Map(),
                splitPrices: new Map(),
                splitPaymentMethods: new Map(),
                perStorePricing: false,
              });
            }}
            options={[
              { value: 'sku', label: i18n.t('run.action.addItem.modeSku') },
              { value: 'expense', label: i18n.t('run.action.addItem.modeExpense') },
            ]}
            ariaLabel={i18n.t('run.action.addItem.modeLabel')}
            // Choosing clears the draft and focuses the new mode's first
            // field, so arrows only move; Space / Enter chooses.
            followFocus={false}
          />

          {/* 1) Identity section — mode-specific. */}
          {draft.mode === 'sku' ? (
            <SkuPicker
              skus={skus}
              existingStoreIdsBySku={existingStoreIdsBySku}
              selectedSku={selectedSku}
              search={search}
              onSearch={setSearch}
              onPick={(sku) =>
                onChange({
                  ...draft,
                  skuId: sku.id,
                  skuCostMode: existingStoreIdsBySku.has(sku.id) ? 'separateExpense' : 'merge',
                })
              }
              onClear={() => onChange({ ...draft, skuId: null, skuCostMode: 'merge' })}
            />
          ) : (
            // M3.44: expense mode — free-text label + optional unit hint.
            <ExpenseIdentity
              draft={draft}
              onChange={onChange}
              templates={expenseTemplates}
              onPickTemplate={(tpl) => {
                // Without prices.view the template has no price: the one
                // typed so far stays (ADM2-01).
                if (tpl.defaultUnitPrice !== null) {
                  setPriceInput(toDisplayPrice(tpl.defaultUnitPrice, priceInThousands));
                }
                onChange({
                  ...draft,
                  label: tpl.label,
                  unitHint: tpl.unitHint ?? '',
                  actualQty: tpl.defaultQty,
                  unitPrice: tpl.defaultUnitPrice ?? draft.unitPrice,
                  paymentMethod: tpl.defaultPaymentMethod === 'transfer' ? 'transfer' : 'cash',
                  splits:
                    draft.splits.size > 0
                      ? evenSplitQty([...draft.splits.keys()], tpl.defaultQty)
                      : draft.splits,
                });
              }}
            />
          )}

          {/* 2) Store selection — SKU mode is single-store dropdown,
                 expense mode is multi-store chips with auto-even-split. */}
          {draft.mode === 'sku' && selectedSku ? (
            <SkuStoreFields
              draft={draft}
              onChange={onChange}
              existing={selectedSkuExisting}
              storeChoices={storeChoices}
              storeById={storeById}
              selectedStoreId={selectedStoreId}
              selectedStoreAlreadyHasSku={selectedStoreAlreadyHasSku}
              recordsAsExpense={skuRecordsAsExpense}
            />
          ) : null}
          {draft.mode === 'expense' && draft.label.trim() ? (
            <ExpenseStoreFields draft={draft} onChange={onChange} storeChoices={storeChoices} />
          ) : null}

          {/* 3) Qty + price + payment + reason + (expense) photo. */}
          {(draft.mode === 'sku' && selectedSku && selectedStoreId) ||
          (draft.mode === 'expense' && draft.label.trim() && draft.splits.size > 0) ? (
            <>
              <QtyPriceFields
                // R2-BUY-4: localised unit; no "（）" without one.
                qtyUnit={
                  draft.mode === 'sku'
                    ? unitLabel.uncounted(selectedSku?.unit)
                    : draft.unitHint.trim()
                }
                qty={draft.actualQty}
                onQty={(qty) => {
                  // M3.44: in expense mode multi-store, re-divide the new
                  // qty across the SAME stores (evenSplitQty: three
                  // decimals, the last store takes the remainder). SKU
                  // mode is single-store, so the lone store gets the full
                  // qty.
                  const storeIds = [...draft.splits.keys()];
                  const next =
                    draft.mode === 'expense' && storeIds.length > 1
                      ? evenSplitQty(storeIds, qty)
                      : (() => {
                          const m = new Map(draft.splits);
                          const [sid] = storeIds;
                          if (sid) m.set(sid, qty);
                          return m;
                        })();
                  onChange({ ...draft, actualQty: qty, splits: next });
                }}
                priceText={priceInput}
                onPriceText={(v) => {
                  setPriceInput(v);
                  onChange({
                    ...draft,
                    unitPrice: fromDisplayPrice(v, priceInThousands),
                  });
                }}
                priceInThousands={priceInThousands}
                onTogglePriceUnit={onTogglePriceUnit}
              />
              {totalHint !== null ? (
                <div className="text-old-label text-[var(--c-fg-muted)]">
                  {/* "Line total: " / "小计：" — the colon belongs to the language. */}
                  {i18n.t('common.labelValue', {
                    label: i18n.t('run.action.addItem.totalHint'),
                    value: '',
                  })}
                  <span className="font-semibold tabular-nums text-[var(--c-fg)]">
                    {formatMoney(totalHint)} {currency}
                  </span>
                </div>
              ) : null}

              {/* Payment method chips — mirror PurchaseSheet's shape. */}
              <div>
                <FieldLabel className="mb-1">{i18n.t('run.label.paymentMethod')}</FieldLabel>
                <PaymentMethodChips
                  value={draft.paymentMethod}
                  onChange={(m) => onChange({ ...draft, paymentMethod: m })}
                />
              </div>

              {/* Reason (required) — the audit gate. The placeholder
                  cues the operator on what's expected (vendor freebie,
                  chef call-in, market deal). */}
              <Field label={i18n.t('run.action.addItem.reasonLabel')}>
                <Input
                  value={draft.reason}
                  onChange={(e) => onChange({ ...draft, reason: e.target.value })}
                  placeholder={i18n.t('run.action.addItem.reasonPlaceholder')}
                />
              </Field>

              {/* Receipt photo — for an expense, or a product recorded as
                  its own cost; always optional (2026-07-06: dropped the
                  >200k mandatory gate). */}
              {draft.mode === 'expense' || skuRecordsAsExpense ? (
                <PhotoCapture
                  label={i18n.t('run.action.receiptPhoto')}
                  value={draft.receiptPhotoUrl}
                  onCapture={(url) => onChange({ ...draft, receiptPhotoUrl: url })}
                  onClear={() => onChange({ ...draft, receiptPhotoUrl: null })}
                  uploader={photoUploader}
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
