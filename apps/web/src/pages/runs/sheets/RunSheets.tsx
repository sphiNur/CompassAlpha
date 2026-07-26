/**
 * Run mutation sheets — extracted verbatim from RunPage.tsx
 * (Phase 4 step 3, FRONTEND_AUDIT_2026-07.md run-domain split).
 *
 *   - PurchaseSheet  advanced per-item purchase editor (splits,
 *                    per-store pricing, receipt photo).
 *   - AddItemSheet   dual-mode "+ add" (existing SKU / off-catalog
 *                    expense) with store allocation.
 *   - ConfirmSheet   reason-prompt confirm used by every run
 *                    transition (start/deliver/finish/cancel/...).
 *
 * All three are props-driven (draft in, callbacks out) — the
 * orchestrator state stays in RunPage. The draft shapes
 * (PurchaseDraft / AddItemDraft) live here with the sheets that edit
 * them; RunPage imports the types to hold the useState.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Input, PhotoCapture, Sheet, useToast } from '@compass/ui';
import { PaymentMethodChips } from '../../../components/PaymentMethodChips';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatQty } from '../../../lib/format';
import { matchesNameLike, normalizeQuery } from '../../../lib/searchMatch';
import type { useI18n } from '../../../hooks/useI18n';
import { toDisplayPrice, fromDisplayPrice } from '../lib/priceMath';

/**
 * M3.41 + M3.44 (2026-05-21 / 2026-05-22): draft state for the "+ add"
 * sheet. Dual-mode:
 *   - `mode: 'sku'`   → AddPurchaserItem mutation (target an existing
 *     SKU, single-store v1, requires supplierId/skuId).
 *   - `mode: 'expense'` → AddRunExpense mutation (free-text label,
 *     multi-store auto-split, target porter/taxi/off-catalog buys).
 *
 * Both modes share the qty/price/split/payment/reason fields so the
 * sheet can switch modes without losing what the user has typed. The
 * mode-specific fields (skuId/supplierId vs expenseId/label/unitHint)
 * stay populated either way; the renderer + submit handler only
 * reads the ones relevant to the active mode.
 *
 * expenseId is pre-generated when the sheet opens so the FE owns the
 * id from the start — enables an instant local "saved!" indicator
 * without a roundtrip, and the same id replays idempotently if the
 * mutation retries.
 */
export interface AddItemDraft {
  mode: 'sku' | 'expense';
  runId: string;
  /** SKU mode — selected SKU id; null until the user picks one. */
  skuId: string | null;
  /** SKU mode — preferred supplier on the SKU (optional override). */
  supplierId: string | null;
  /** Existing SKU mode: merge into the run row or record a store-level cost. */
  skuCostMode: 'merge' | 'separateExpense';
  /** Expense mode — pre-generated UUID. */
  expenseId: string;
  /** Expense mode — free-text identity. */
  label: string;
  /** Expense mode — optional unit hint ("trip", "pack", null). */
  unitHint: string;
  /** Shared costs are evenly allocated; store costs belong to one branch. */
  expenseScope: 'shared' | 'store';
  // Shared across both modes
  actualQty: string;
  unitPrice: string;
  /** storeId → qty. Only stores in the run's existing scope are valid. */
  splits: Map<string, string>;
  splitPrices: Map<string, string>;
  splitPaymentMethods: Map<string, 'cash' | 'transfer'>;
  perStorePricing: boolean;
  paymentMethod: 'cash' | 'transfer';
  receiptPhotoUrl: string | null;
  reason: string;
}

export interface PurchaseDraft {
  /** When set, this is an EDIT of an existing purchase. The submit button
   *  switches to revisePurchase and the reason field becomes required. */
  isEdit: boolean;
  skuId: string;
  runId: string;
  unitPrice: string;
  actualQty: string;
  supplierId: string | null;
  splits: Map<string, string>; // storeId -> qty
  splitPrices: Map<string, string>;
  splitPaymentMethods: Map<string, 'cash' | 'transfer'>;
  perStorePricing: boolean;
  receiptPhotoUrl: string | null;
  reason: string;
  /** M1.14: cash | transfer. Defaults to 'cash' for new purchases (the
   *  common case at the market). Edit pre-fills from the existing item. */
  paymentMethod: 'cash' | 'transfer';
}

interface PurchaseSheetProps {
  draft: PurchaseDraft | null;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  suppliers: Array<{ id: string; name: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  photoUploader: import('@compass/ui').PhotoUploader | undefined;
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, display + accept price in thousands. Draft
   *  always stores raw UZS — only the visible input value is divided. */
  priceInThousands: boolean;
  onCancel: () => void;
  onChange: (d: PurchaseDraft | null) => void;
  onSubmit: (d: PurchaseDraft) => void;
  submitting: boolean;
}


export function PurchaseSheet({
  draft,
  skuById,
  storeById,
  suppliers,
  productName,
  photoUploader,
  i18n,
  priceInThousands,
  onCancel,
  onChange,
  onSubmit,
  submitting,
}: PurchaseSheetProps) {
  const toast = useToast();
  const sku = draft ? skuById.get(draft.skuId) : null;
  const candidateStores = useMemo(() => [...storeById.values()], [storeById]);

  // M3.36: local display state for the price input. Decoupled from
  // draft.unitPrice (which always holds raw UZS) so intermediate
  // typing states like "147." don't get round-tripped through
  // String(Number()) and lose the trailing decimal. Resynced when
  // the sheet opens on a different row or the mode flips.
  const [priceInput, setPriceInput] = useState<string>('');
  useEffect(() => {
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

  const splitTotal = useMemo(() => {
    if (!draft) return 0;
    let s = 0;
    for (const v of draft.splits.values()) s += Number(v) || 0;
    return s;
  }, [draft]);

  const splitMatches = draft && Math.abs(splitTotal - Number(draft.actualQty || 0)) < 0.001;
  const reasonOk = !draft?.isEdit || draft.reason.trim().length > 0;
  const splitPricesOk =
    !draft?.perStorePricing ||
    [...draft.splits.entries()]
      .filter(([, qty]) => Number(qty) > 0)
      .every(([storeId]) => Number(draft.splitPrices.get(storeId) || draft.unitPrice) > 0);
  const canSubmit = !!(
    draft &&
    Number(draft.actualQty) > 0 &&
    Number(draft.unitPrice) > 0 &&
    splitMatches &&
    reasonOk &&
    splitPricesOk
  );

  // M3.49 (2026-05-23): the sheet's own footer button is now ALWAYS
  // rendered — the in-page PageMainButton is hidden behind the sheet
  // when one opens, so each sheet must own its primary CTA.
  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && onCancel()}
      title={
        draft?.isEdit
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
          onClick={() =>
            draft &&
            (canSubmit
              ? onSubmit(draft)
              : toast.error(i18n.t('run.errors.splitsMustSum')))
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
          {draft.isEdit ? (
            <Banner tone="info" title={i18n.t('run.confirm.editPurchase.body')} />
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.action.actualQty', { unit: sku?.unit ?? '' })}
              <Input
                className="mt-1"
                type="number"
                inputMode="decimal"
                step={sku?.step ?? '1'}
                value={draft.actualQty}
                onChange={(e) => onChange({ ...draft, actualQty: e.target.value })}
                autoFocus
              />
            </label>
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {priceInThousands
                ? i18n.t('run.action.unitPriceUzsThousands')
                : i18n.t('run.action.unitPriceUzs')}
              <Input
                className="mt-1"
                type="number"
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setPriceInput(v);
                  // M3.36: draft always stores raw UZS — multiply
                  // back when committing. The display state is the
                  // source of truth for what's shown.
                  onChange({
                    ...draft,
                    unitPrice: fromDisplayPrice(v, priceInThousands),
                  });
                }}
              />
            </label>
          </div>
          {/* M1.14: payment method picker. Two-segment chip group so
              both options are always visible — radio behaviour without
              the OS-styled radio buttons. */}
          <div>
            <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.label.paymentMethod')}
            </div>
            <PaymentMethodChips
              value={draft.paymentMethod}
              onChange={(m) => onChange({ ...draft, paymentMethod: m })}
            />
          </div>
          <button
            type="button"
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
            className="press rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-2 text-label font-semibold text-[var(--c-fg)] ring-hairline"
          >
            {/* 2026-07-26: both labels were hard-coded Chinese. */}
            {draft.perStorePricing
              ? i18n.t('run.purchase.pricingUniform')
              : i18n.t('run.purchase.pricingPerStore')}
          </button>
          {suppliers.length > 0 ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.action.supplier')}
              <select
                className="mt-1 h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={draft.supplierId ?? ''}
                onChange={(e) => onChange({ ...draft, supplierId: e.target.value || null })}
              >
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
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
              <span className="text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.allocateAcrossStores')}
              </span>
              <span
                className={`font-mono text-label tabular-nums ${
                  splitMatches ? 'text-[var(--c-success)]' : 'text-[var(--c-warning-fg)]'
                }`}
              >
                {formatQty(splitTotal)} / {formatQty(draft.actualQty || '0')}
              </span>
            </div>
            <ul className="flex flex-col gap-2">
              {candidateStores.map((store) => {
                const splitQty = draft.splits.get(store.id) ?? '';
                return (
                  <li key={store.id} className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate text-body">{store.name}</span>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step={sku?.step ?? '1'}
                        value={splitQty}
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
                          value={toDisplayPrice(
                            draft.splitPrices.get(store.id) ?? draft.unitPrice,
                            priceInThousands,
                          )}
                          onChange={(e) => {
                            const next = new Map(draft.splitPrices);
                            next.set(store.id, fromDisplayPrice(e.target.value, priceInThousands));
                            onChange({ ...draft, splitPrices: next });
                          }}
                          className="text-right"
                        />
                        <div className="flex rounded-[var(--r-pill)] bg-[var(--c-surface)] p-1 ring-hairline">
                          {(['cash', 'transfer'] as const).map((method) => {
                            const selected =
                              (draft.splitPaymentMethods.get(store.id) ?? draft.paymentMethod) === method;
                            return (
                              <button
                                key={method}
                                type="button"
                                onClick={() => {
                                  const next = new Map(draft.splitPaymentMethods);
                                  next.set(store.id, method);
                                  onChange({ ...draft, splitPaymentMethods: next });
                                }}
                                className={
                                  'rounded-[var(--r-pill)] px-2 py-1 text-label font-semibold ' +
                                  (selected
                                    ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                                    : 'text-[var(--c-fg-muted)]')
                                }
                              >
                                {method === 'cash'
                                  ? i18n.t('run.label.paymentCash')
                                  : i18n.t('run.label.paymentTransfer')}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
          {draft.isEdit ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.label.reasonForChange')}
              <Input
                className="mt-1"
                value={draft.reason}
                onChange={(e) => onChange({ ...draft, reason: e.target.value })}
                placeholder={i18n.t('run.label.reasonPlaceholder')}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

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
 *   4. Type a reason (required — audit log answers "why was this
 *      added beyond the original order?").
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
 */
export function AddItemSheet({
  draft,
  runStoreIds,
  existingStoreIdsBySku,
  skus,
  expenseTemplates,
  storeById,
  productName,
  photoUploader,
  i18n,
  priceInThousands,
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
  existingStoreIdsBySku: Map<string, { storeIds: Set<string>; status: string }>;
  skus: Array<{
    id: string;
    names: Record<string, string>;
    code?: string | null;
    unit: string;
    step: string;
    isArchived: boolean;
  }>;
  expenseTemplates: Array<{
    id: string;
    label: string;
    unitHint: string | null;
    defaultQty: string;
    defaultUnitPrice: string;
    defaultPaymentMethod: string;
  }>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  /** M3.44: PhotoUploader for receipt capture. SKU mode doesn't use it
   *  today; expense mode requires it when total > 200,000 UZS. */
  photoUploader: import('@compass/ui').PhotoUploader | undefined;
  i18n: ReturnType<typeof useI18n>;
  priceInThousands: boolean;
  onCancel: () => void;
  onChange: (d: AddItemDraft | null) => void;
  onSubmit: (d: AddItemDraft) => void;
  submitting: boolean;
}) {
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const [search, setSearch] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const initializedExpenseScopeRef = useRef<string | null>(null);

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

  // Filter the SKU list: archived and unavailable-in-run SKUs stay out,
  // but purchasable existing SKUs remain selectable. Duplicate store/SKU
  // entries are recorded as store-scoped expenses so prices can differ.
  const filteredSkus = useMemo(() => {
    const tokens = normalizeQuery(search);
    return skus
      .filter((sku) => {
        if (sku.isArchived) return false;
        const existing = existingStoreIdsBySku.get(sku.id);
        if (existing) {
          // N/A is a run-wide signal; the purchaser can't override it by
          // re-adding the same SKU as a different store expense.
          if (existing.status === 'unavailable') return false;
        }
        return true;
      })
      .filter((sku) => {
        if (!tokens) return true;
        return matchesNameLike(
          { names: sku.names as Record<string, string> | null, code: sku.code ?? null },
          tokens,
        );
      })
      .slice(0, 20);
  }, [skus, existingStoreIdsBySku, search]);

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
    const all = runStoreIds
      .map((id) => storeById.get(id))
      .filter((s): s is { id: string; name: string; code: string | null } => !!s);
    return all;
  }, [runStoreIds, storeById]);
  const selectedStoreId = draft && draft.splits.size === 1 ? [...draft.splits.keys()][0]! : '';
  const selectedStoreAlreadyHasSku =
    !!selectedStoreId && !!selectedSkuExisting?.storeIds.has(selectedStoreId);
  const skuRecordsAsExpense =
    draft?.mode === 'sku' &&
    !!selectedSkuExisting &&
    (draft.skuCostMode === 'separateExpense' || selectedStoreAlreadyHasSku);

  const totalHint = useMemo(() => {
    if (!draft) return null;
    const q = Number(draft.actualQty);
    const p = Number(priceInput);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
    const effectiveP = priceInThousands ? p * 1000 : p;
    return Math.round(q * effectiveP);
  }, [draft, priceInput, priceInThousands]);

  // 2026-07-06: the >200,000 UZS "receipt photo required" gate on
  // expenses was removed. Every expense already carries a mandatory
  // reason (the real audit trail); blocking a bazaar purchase because
  // no paper receipt is available was the wrong trade. The photo stays
  // available but optional.

  // Mode-aware split-sum check: in expense mode the split is multi-
  // store auto-divided, so the sum may drift by 1 UZS due to integer
  // rounding. Tolerate that small delta; the domain layer uses the
  // same TOLERANCE constant.
  const splitTotal = useMemo(() => {
    if (!draft) return 0;
    let s = 0;
    for (const v of draft.splits.values()) s += Number(v) || 0;
    return s;
  }, [draft]);
  const splitMatches = !!draft && Math.abs(splitTotal - Number(draft.actualQty || 0)) < 0.001;

  const canSubmit = !!(
    draft &&
    (draft.mode === 'sku' ? draft.skuId : draft.label.trim().length > 0) &&
    Number(draft.actualQty) > 0 &&
    Number(draft.unitPrice) > 0 &&
    draft.splits.size > 0 &&
    splitMatches &&
    draft.reason.trim().length > 0 &&
    !submitting
  );

  // M3.44: helper — auto-split actualQty evenly across selected stores,
  // rounded to integers, remainder to the last store. Matches the
  // domain TOLERANCE check. E.g. 70k / 3 = 23k, 23k, 24k.
  //
  // M3.51 (2026-05-23): when qty hasn't been entered yet, STILL register
  // every selected store in the map (with empty values). Without this,
  // tapping a store chip before typing qty produced an empty map (Number('')
  // is 0 → the early-return below fired) → splits.size stayed 0 → the
  // qty input row was gated on splits.size > 0, so it never appeared → user
  // got stuck unable to add a single-store expense (or multi-store
  // expense from a fresh sheet). The "stub" entries get overwritten by
  // the qty input's onChange handler the moment the user types.
  const evenSplit = (storeIds: string[], qtyStr: string) => {
    const next = new Map<string, string>();
    if (storeIds.length === 0) return next;
    const q = Number(qtyStr);
    if (!Number.isFinite(q) || q <= 0) {
      // No qty yet — register each selected store with an empty
      // value. canSubmit still gates on Number(actualQty) > 0 +
      // splitMatches, so the user can't accidentally submit a $0
      // expense via this branch.
      for (const id of storeIds) next.set(id, '');
      return next;
    }
    if (storeIds.length === 1) {
      next.set(storeIds[0]!, qtyStr);
      return next;
    }
    const base = Math.floor(q / storeIds.length);
    let allocated = 0;
    for (let i = 0; i < storeIds.length - 1; i++) {
      next.set(storeIds[i]!, String(base));
      allocated += base;
    }
    // Last store absorbs the remainder so the sum matches actualQty exactly.
    next.set(storeIds[storeIds.length - 1]!, String(q - allocated));
    return next;
  };

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
      splits: evenSplit(
        storeChoices.map((store) => store.id),
        draft.actualQty,
      ),
    });
  }, [draft, onChange, storeChoices]);

  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && onCancel()}
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
          <div className="flex gap-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] p-1">
            {(['sku', 'expense'] as const).map((m) => {
              const selected = draft.mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    if (draft.mode === m) return;
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
                  className={
                    'flex-1 rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ' +
                    (selected
                      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                      : 'text-[var(--c-fg-muted)]')
                  }
                >
                  {m === 'sku'
                    ? i18n.t('run.action.addItem.modeSku')
                    : i18n.t('run.action.addItem.modeExpense')}
                </button>
              );
            })}
          </div>

          {/* 1) Identity section — mode-specific. */}
          {draft.mode === 'sku' ? (
            selectedSku ? (
              <div className="flex items-center justify-between rounded-md bg-[var(--c-surface-2)] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-body font-semibold">
                    {productName(selectedSku)}
                  </div>
                  <div className="text-label text-[var(--c-fg-muted)]">
                    {selectedSku.unit}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onChange({ ...draft, skuId: null, skuCostMode: 'merge' })
                  }
                  className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
                >
                  {i18n.t('run.action.addItem.changeSku')}
                </button>
              </div>
            ) : (
              <>
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={i18n.t('run.action.addItem.searchPlaceholder')}
                  autoFocus
                />
                <ul className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-[var(--c-divider)]">
                  {filteredSkus.length === 0 ? (
                    <li className="px-3 py-2 text-body-sm text-[var(--c-fg-muted)]">
                      {i18n.t('run.action.addItem.noMatch')}
                    </li>
                  ) : (
                    filteredSkus.map((sku) => (
                      <li
                        key={sku.id}
                        className="border-b border-[var(--c-divider)] last:border-b-0"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            onChange({
                              ...draft,
                              skuId: sku.id,
                              skuCostMode: existingStoreIdsBySku.has(sku.id)
                                ? 'separateExpense'
                                : 'merge',
                            })
                          }
                          className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left active:bg-[var(--c-surface-2)]"
                        >
                          <span className="min-w-0 truncate text-body">
                            {productName(sku)}
                          </span>
                          <span className="shrink-0 text-label text-[var(--c-fg-muted)]">
                            {sku.unit}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </>
            )
          ) : (
            // M3.44: expense mode — free-text label + optional unit hint.
            <>
              <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.addExpense.labelInput')}
                <Input
                  className="mt-1"
                  value={draft.label}
                  onChange={(e) => onChange({ ...draft, label: e.target.value })}
                  placeholder={i18n.t('run.action.addExpense.labelPlaceholder')}
                  autoFocus
                />
              </label>
              <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.addExpense.unitHint')}
                <Input
                  className="mt-1"
                  value={draft.unitHint}
                  onChange={(e) => onChange({ ...draft, unitHint: e.target.value })}
                  placeholder={i18n.t('run.action.addExpense.unitHintPlaceholder')}
                />
              </label>
              {expenseTemplates.length > 0 ? (
                <div>
                  <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                    {i18n.t('run.action.addExpense.templates')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {expenseTemplates.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => {
                          setPriceInput(
                            toDisplayPrice(tpl.defaultUnitPrice, priceInThousands),
                          );
                          onChange({
                            ...draft,
                            label: tpl.label,
                            unitHint: tpl.unitHint ?? '',
                            actualQty: tpl.defaultQty,
                            unitPrice: tpl.defaultUnitPrice,
                            paymentMethod:
                              tpl.defaultPaymentMethod === 'transfer'
                                ? 'transfer'
                                : 'cash',
                            splits:
                              draft.splits.size > 0
                                ? evenSplit([...draft.splits.keys()], tpl.defaultQty)
                                : draft.splits,
                          });
                        }}
                        className="rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-1 text-label font-medium text-[var(--c-fg)] ring-hairline active:opacity-70"
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}

          {/* M3.54 (2026-05-23): cross-store augmentation hint. Renders
              when the picked SKU is already in this run for some other
              stores — explains that the new demand will be merged into
              the existing row (purchaseItem / revisePurchase under the
              hood) so the manager doesn't see "duplicate apple line".
              Lists the stores that already have demand so the user
              knows which stores aren't available in the dropdown. */}
          {draft.mode === 'sku' && selectedSku && selectedSkuExisting ? (
            <div className="rounded-md bg-[var(--c-warning)]/10 px-3 py-2 text-label text-[var(--c-fg)] ring-1 ring-[var(--c-warning)]">
              {i18n.t('run.action.addItem.crossStoreHint', {
                stores: [...selectedSkuExisting.storeIds]
                  .map((id) => storeById.get(id)?.name ?? id.slice(0, 8))
                  .join(', '),
              })}
            </div>
          ) : null}
          {/* 2) Store selection — SKU mode is single-store dropdown,
                 expense mode is multi-store chips with auto-even-split. */}
          {draft.mode === 'sku' && selectedSku && selectedSkuExisting ? (
            <div className="rounded-md bg-[var(--c-surface-2)] p-2">
              <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.addItem.costModeTitle')}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  disabled={selectedStoreAlreadyHasSku}
                  onClick={() => onChange({ ...draft, skuCostMode: 'merge' })}
                  className={
                    'rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline disabled:opacity-40 ' +
                    (!skuRecordsAsExpense
                      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                      : 'bg-[var(--c-bg)] text-[var(--c-fg-muted)]')
                  }
                >
                  {i18n.t('run.action.addItem.costModeMerge')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onChange({ ...draft, skuCostMode: 'separateExpense' })
                  }
                  className={
                    'rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline ' +
                    (skuRecordsAsExpense
                      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                      : 'bg-[var(--c-bg)] text-[var(--c-fg-muted)]')
                  }
                >
                  {i18n.t('run.action.addItem.costModeSeparate')}
                </button>
              </div>
              <p className="mt-1 text-label leading-snug text-[var(--c-fg-muted)]">
                {selectedStoreAlreadyHasSku
                  ? i18n.t('run.action.addItem.storeAlreadyHasSkuHint')
                  : skuRecordsAsExpense
                    ? i18n.t('run.action.addItem.separatePriceHint')
                    : i18n.t('run.action.addItem.mergePriceHint')}
              </p>
            </div>
          ) : null}
          {draft.mode === 'sku' && selectedSku ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.action.addItem.targetStore')}
              <select
                className="mt-1 h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={selectedStoreId}
                onChange={(e) => {
                  const next = new Map<string, string>();
                  if (e.target.value && draft.actualQty) {
                    next.set(e.target.value, draft.actualQty);
                  } else if (e.target.value) {
                    next.set(e.target.value, '');
                  }
                  onChange({
                    ...draft,
                    splits: next,
                    skuCostMode: selectedSkuExisting?.storeIds.has(e.target.value)
                      ? 'separateExpense'
                      : draft.skuCostMode,
                  });
                }}
              >
                <option value="">{i18n.t('run.action.addItem.pickStore')}</option>
                {storeChoices.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                    {selectedSkuExisting?.storeIds.has(st.id)
                      ? ` (${i18n.t('run.action.addItem.storeAlreadyHasSkuShort')})`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {draft.mode === 'expense' && draft.label.trim() ? (
            <div>
              <div className="mb-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.addExpense.scopeTitle')}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(['shared', 'store'] as const).map((scope) => {
                    const selected = draft.expenseScope === scope;
                    return (
                      <button
                        key={scope}
                        type="button"
                        onClick={() =>
                          onChange({
                            ...draft,
                            expenseScope: scope,
                            splits:
                              scope === 'shared'
                                ? evenSplit(storeChoices.map((store) => store.id), draft.actualQty)
                                : new Map(),
                          })
                        }
                        className={
                          'rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline ' +
                          (selected
                            ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                            : 'bg-[var(--c-bg)] text-[var(--c-fg-muted)]')
                        }
                      >
                        {scope === 'shared'
                          ? i18n.t('run.action.addExpense.scopeShared')
                          : i18n.t('run.action.addExpense.scopeStore')}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-label leading-snug text-[var(--c-fg-muted)]">
                  {draft.expenseScope === 'shared'
                    ? i18n.t('run.action.addExpense.scopeSharedHint')
                    : i18n.t('run.action.addExpense.scopeStoreHint')}
                </p>
              </div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-label font-semibold text-[var(--c-fg-muted)]">
                  {draft.expenseScope === 'shared'
                    ? i18n.t('run.action.addExpense.targetStores')
                    : i18n.t('run.action.addItem.targetStore')}
                </span>
                <span className="text-label text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.addExpense.splitHint', {
                    n: draft.splits.size,
                  })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {storeChoices.map((st) => {
                  const selected = draft.splits.has(st.id);
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => {
                        const nextIds =
                          draft.expenseScope === 'store'
                            ? [st.id]
                            : selected
                              ? [...draft.splits.keys()].filter((id) => id !== st.id)
                              : [...draft.splits.keys(), st.id];
                        onChange({
                          ...draft,
                          splits: evenSplit(nextIds, draft.actualQty),
                        });
                      }}
                      className={
                        'rounded-[var(--r-pill)] px-3 py-1 text-label font-medium ' +
                        (selected
                          ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                          : 'bg-[var(--c-surface-2)] text-[var(--c-fg)] ring-hairline')
                      }
                    >
                      {st.name}
                      {selected && draft.splits.size > 1 ? (
                        <span className="ml-1 font-mono tabular-nums opacity-80">
                          {draft.splits.get(st.id) ?? '0'}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {draft.splits.size > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...draft,
                      splits: evenSplit([...draft.splits.keys()], draft.actualQty),
                    })
                  }
                  className="mt-2 text-label text-[var(--c-action)] active:opacity-70"
                >
                  {i18n.t('run.action.addExpense.resplitEvenly')}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* 3) Qty + price + payment + reason + (expense) photo. */}
          {(draft.mode === 'sku' && selectedSku && selectedStoreId) ||
          (draft.mode === 'expense' &&
            draft.label.trim() &&
            draft.splits.size > 0) ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.actualQty', {
                    unit:
                      draft.mode === 'sku'
                        ? selectedSku?.unit ?? ''
                        : draft.unitHint.trim() || '',
                  })}
                  <Input
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    step={draft.mode === 'sku' ? (selectedSku?.step ?? '1') : '1'}
                    value={draft.actualQty}
                    onChange={(e) => {
                      const qty = e.target.value;
                      // M3.44: in expense mode multi-store, re-divide
                      // the new qty across the SAME stores via
                      // evenSplit (integer rounding, last absorbs
                      // remainder). SKU mode is single-store, so the
                      // lone store gets the full qty.
                      const storeIds = [...draft.splits.keys()];
                      const next =
                        draft.mode === 'expense' && storeIds.length > 1
                          ? evenSplit(storeIds, qty)
                          : (() => {
                              const m = new Map(draft.splits);
                              const [sid] = storeIds;
                              if (sid) m.set(sid, qty);
                              return m;
                            })();
                      onChange({ ...draft, actualQty: qty, splits: next });
                    }}
                  />
                </label>
                <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                  {priceInThousands
                    ? i18n.t('run.action.unitPriceUzsThousands')
                    : i18n.t('run.action.unitPriceUzs')}
                  <Input
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    value={priceInput}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPriceInput(v);
                      onChange({
                        ...draft,
                        unitPrice: fromDisplayPrice(v, priceInThousands),
                      });
                    }}
                  />
                </label>
              </div>
              {totalHint !== null ? (
                <div className="text-label text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.addItem.totalHint')}:{' '}
                  <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">
                    {formatMoney(totalHint)} {currency}
                  </span>
                </div>
              ) : null}

              {/* Payment method chips — mirror PurchaseSheet's shape. */}
              <div>
                <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                  {i18n.t('run.label.paymentMethod')}
                </div>
                <PaymentMethodChips
                  value={draft.paymentMethod}
                  onChange={(m) => onChange({ ...draft, paymentMethod: m })}
                />
              </div>

              {/* Reason (required) — the audit gate. The placeholder
                  cues the operator on what's expected (vendor freebie,
                  chef call-in, market deal). */}
              <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.addItem.reasonLabel')}
                <Input
                  className="mt-1"
                  value={draft.reason}
                  onChange={(e) => onChange({ ...draft, reason: e.target.value })}
                  placeholder={i18n.t('run.action.addItem.reasonPlaceholder')}
                />
              </label>

              {/* Receipt photo — expense mode only, always optional
                  (2026-07-06: dropped the >200k mandatory gate). */}
              {draft.mode === 'expense' || skuRecordsAsExpense ? (
                <div>
                  <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                    {i18n.t('run.action.addExpense.receiptOptional')}
                  </div>
                  <PhotoCapture
                    label={i18n.t('run.action.receiptPhoto')}
                    value={draft.receiptPhotoUrl}
                    onCapture={(url) =>
                      onChange({ ...draft, receiptPhotoUrl: url })
                    }
                    onClear={() =>
                      onChange({ ...draft, receiptPhotoUrl: null })
                    }
                    uploader={photoUploader}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/** Generic confirm sheet used by every major transition. Single component
 *  + single render slot keeps the look-and-feel identical across:
 *  Start/Stop purchase, Start/Stop delivery, Deliver to store, Recall
 *  delivery, Cancel run, Unmark unavailable. */
export function ConfirmSheet({
  config,
  reason,
  onReasonChange,
  onCancel,
  i18n,
}: {
  config:
    | {
        title: string;
        body: string;
        confirmLabel: string;
        danger: boolean;
        requireReason: boolean;
        /**
         * M1.7-A (2026-05-06): "soft" reason — when true, the reason
         * input is rendered (so the operator CAN add context) but
         * submit is NOT gated on it. Used by the cancel-run flow
         * where requiring a reason produces "asdf" noise but having
         * the option to write one helps the team learn.
         * `requireReason: true` overrides this (hard requirement).
         */
        reasonOptional?: boolean;
        /** Override the default reason placeholder copy. */
        reasonPlaceholder?: string;
        isPending: boolean;
        run: () => void;
      }
    | null;
  reason: string;
  onReasonChange: (s: string) => void;
  onCancel: () => void;
  i18n: ReturnType<typeof useI18n>;
}) {
  const reasonOk = !config?.requireReason || reason.trim().length > 0;
  // M1.13 (2026-05-08): for soft-reason flows (cancel-run is the only
  // current consumer), the input is hidden behind a small "Add note
  // (optional)" toggle. Was: input always visible + autofocused →
  // keyboard popped → user felt obligated to type "asdf" or similar
  // noise. Now: 1-tap confirm by default, expand only if you actually
  // have something to say. Hard `requireReason` flows still render
  // the input unconditionally as before.
  const [reasonExpanded, setReasonExpanded] = useState(false);
  // Reset expanded state every time the sheet opens with a new config
  // so a previously-expanded reason field doesn't leak across confirms.
  useEffect(() => {
    if (!config) setReasonExpanded(false);
  }, [config]);
  const isHardReason = !!config?.requireReason;
  const isSoftReason = !!(config && !isHardReason && config.reasonOptional);
  const showReasonField = isHardReason || (isSoftReason && reasonExpanded);
  const showReasonToggle = isSoftReason && !reasonExpanded;
  // Inside Telegram the MainButton drives the primary action — the sheet
  // doesn't need its own confirm button. The Cancel button was also
  // dropped (2026-05-04, user feedback) because:
  //   - tap-on-backdrop, swipe-down, and Telegram BackButton all close the
  //     sheet — three dismiss paths is plenty for a 1-action confirmation
  //   - on a 640px WebView the trailing "Cancel" was ~52px of muted-pearl
  //     button that visually competed with the body text and made cancel
  //     feel like the default
  // We DO keep the Cancel button when the user has to type a reason —
  // the soft keyboard covers the backdrop, so without an explicit close
  // target they'd have to dismiss the keyboard first to tap outside.
  // M3.49 (2026-05-23): the in-page PageMainButton sits behind any
  // open sheet — so we always show the confirm sheet's own primary
  // button now, regardless of Telegram presence. Was `!inTelegram`
  // (Telegram MainButton was the canonical CTA), no longer correct.
  const showCancel = isHardReason || (isSoftReason && reasonExpanded);
  const showPrimary = true;
  const hasFooter = showPrimary || showCancel;
  return (
    <Sheet
      open={!!config}
      onOpenChange={(open) => {
        // M3.10: block dismiss while the wrapped mutation is in flight.
        // Without this the operator could swipe-down (or tap-outside)
        // mid-mutation, the local reason text would clear on cancel,
        // and a subsequent failure would arrive as an error toast with
        // no way to retry without re-typing the reason. The sheet
        // naturally closes via the mutation's onSuccess callback.
        if (!open && config?.isPending) return;
        if (!open) onCancel();
      }}
      title={config?.title ?? ''}
      footer={
        hasFooter ? (
          <div className="flex flex-col gap-2">
            {showPrimary ? (
              <Button
                block
                variant={config?.danger ? 'danger' : undefined}
                loading={config?.isPending}
                disabled={!reasonOk}
                onClick={() => config?.run()}
              >
                {config?.confirmLabel ?? ''}
              </Button>
            ) : null}
            {showCancel ? (
              <Button block variant="pearl" onClick={onCancel}>
                {i18n.t('common.cancel')}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {config ? (
        <div className="flex flex-col gap-3 py-3">
          <p className="whitespace-pre-line text-body leading-snug text-[var(--c-fg-muted)]">
            {config.body}
          </p>
          {showReasonField ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.label.reasonForChange')}
              <Input
                className="mt-1"
                value={reason}
                onChange={(e) => onReasonChange(e.target.value)}
                placeholder={
                  config.reasonPlaceholder ?? i18n.t('run.label.reasonPlaceholder')
                }
                autoFocus={isHardReason}
              />
            </label>
          ) : null}
          {showReasonToggle ? (
            <button
              type="button"
              onClick={() => setReasonExpanded(true)}
              className="self-start text-label text-[var(--c-action)] active:opacity-70"
            >
              {i18n.t('run.label.addReasonOptional')}
            </button>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
