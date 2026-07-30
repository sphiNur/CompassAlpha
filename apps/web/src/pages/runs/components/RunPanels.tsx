/**
 * Run mid-level panels — extracted verbatim from RunPage.tsx
 * (Phase 4 step 5, FRONTEND_AUDIT_2026-07.md run-domain split).
 *
 *   - ActiveRunPanel     the in-run composer: inline-edit rows across
 *                        purchasing/delivering phases; mounts the
 *                        grouped views + PurchaseRow leaf.
 *   - PreviewSummaryCard planned-run preview (overall / by store /
 *                        by supplier) + vendor copy-list actions.
 *   - VendorPickerSheet  supplier re-assign sheet (internal).
 *   - RunSessionsCard    source-session submissions during the run.
 *
 * Props-driven; orchestrator state and mutations stay in RunPage.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardTitle,
  Chip,
  ChipBar,
  EmptyState,
  SectionLabel,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { shareLink } from '../../../lib/telegramLinks';
import { formatMoney, formatQty } from '../../../lib/format';
import { useI18n, useUnitLabel } from '../../../hooks/useI18n';
import { haptic, getTg } from '../../../hooks/useTelegram';
import {
  PerStoreView,
  PerVendorView,
  PerCategoryView,
  RunExtrasCard,
  ExpensesCard,
  PurchaseRow,
} from '../views/RunViews';
import type {
  ActiveRun,
  PreviewLine,
  PreviewStoreGroup,
  PreviewSupplierGroup,
} from '../types';
import {
  buildStoreText as buildStoreTextPure,
  buildSupplierText as buildSupplierTextPure,
} from '../lib/shareText';
import type { ShareTextDeps } from '../lib/shareText';
import { computePreviewStats } from '../lib/previewStats';
import { isOpen, pruneOpen, toggleOpen } from '../lib/accordion';
import {
  countStoreLines,
  countSupplierLines,
  filterStoreGroups,
  filterSupplierGroups,
} from '../lib/previewFilter';
import { normalizeQuery } from '../../../lib/searchMatch';
import {
  countByStatus,
  visibleItems,
  type ItemFilter,
  type ItemView,
} from '../lib/itemList';

// formatQty / formatMoney are imported from `../lib/format` —
// thousand-separator + max-1-decimal display rule applied everywhere.

/**
 * Active-run panel — INLINE-EDIT list rows.
 *
 * Design rationale (rewritten 2026-05-03 after user feedback):
 *
 *   "真正采购时物品很多,几百种东西要采购,一个一个点开非常麻烦"
 *
 * Translation: "When purchasing for real there are many items — hundreds.
 * Tapping each one open is intolerable." So we ditch the tap-row → action
 * sheet pattern entirely and edit IN PLACE:
 *
 *   - Purchasing phase, pending row:
 *       inline qty input + price input + N/A pill + (sometimes)
 *       "更多 splits…" link if multi-store and qty changes from planned.
 *       Auto-saves on price-field blur once qty AND price are valid.
 *   - Purchasing phase, purchased row:
 *       shows current values + small "Edit" link → opens PurchaseSheet
 *       (full form because RevisePurchase requires a reason field).
 *   - Purchasing phase, unavailable row:
 *       shows reason + small "Restore" link → opens "Mark available?"
 *       confirm sheet.
 *   - Delivering phase store rows:
 *       Tap row routes directly to the appropriate confirm sheet.
 *       Confirmed stores are read-only (not tappable).
 *
 * No more stacked menu sheets. Page-level Telegram MainButton still
 * drives Start purchase / Start delivery / Finish run.
 */
export function ActiveRunPanel({
  run,
  skuById,
  categoryById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  onTogglePriceUnit,
  savingSkuId,
  onSavePurchaseInline,
  onMarkNa,
  onEditPurchased,
  onUnmark,
  onOpenAdvancedPurchase,
  onDeliverStore,
  onRecallStore,
  onMarkExtraStatus,
  onRecordExtraExpense,
  onRemoveExpense,
  onOpenExpense,
  onSetPaymentMethod,
  paymentBusySkuId,
}: {
  run: ActiveRun;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  categoryById: Map<string, { id: string; names: Record<string, string> }>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, inline price input + sheet input display `value/1000`
   *  and parse back to raw UZS on save. Page-level toggle in the
   *  sticky header. */
  priceInThousands: boolean;
  /** Forwarded to PurchaseRow's unit-suffix toggle. */
  onTogglePriceUnit: () => void;
  savingSkuId: string | null;
  onSavePurchaseInline: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    /** See the identical field on RunViews' views — only the by-stall
     *  view supplies it; this panel's aggregate rows send nothing. */
    supplierId?: string | null;
    storeSplits: Array<{
      storeId: string;
      qty: string;
      unitPrice?: string;
      paymentMethod?: 'cash' | 'transfer';
    }>;
    paymentMethod: 'cash' | 'transfer';
  }) => void;
  onMarkNa: (skuId: string) => void;
  onEditPurchased: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  onOpenAdvancedPurchase: (item: ActiveRun['items'][number]) => void;
  onDeliverStore: (storeId: string, storeName: string) => void;
  onRecallStore: (storeId: string, storeName: string) => void;
  /** M3.37 (Wave2 #5): mark a single "其他物品" row's outcome. */
  onMarkExtraStatus: (
    sessionId: string,
    extraIndex: number,
    status: 'pending' | 'bought' | 'unavailable',
  ) => void;
  onRecordExtraExpense: (
    storeId: string,
    extra: { name: string; qty: string; unit: string; note?: string },
  ) => void;
  /** M3.44: remove an off-catalog expense (purchasing phase only). */
  onRemoveExpense: (expenseId: string, label: string) => void;
  onOpenExpense: () => void;
  onSetPaymentMethod: (
    item: ActiveRun['items'][number],
    next: 'cash' | 'transfer',
  ) => void;
  paymentBusySkuId: string | null;
}) {
  // 2026-07-26: the AGGREGATE view — the default screen during an
  // actual run — passed the raw canonical unit code down to
  // PurchaseRow, so the same SKU read "bunch" here and "把" on the
  // preview card. Same fix as the three grouped views in RunViews.
  const unitLabel = useUnitLabel();

  const involvedStoreIds = useMemo(() => {
    const ids = new Set<string>();
    for (const sp of run.splits) ids.add(sp.storeId);
    return [...ids];
  }, [run.splits]);

  /**
   * Map of SKU → per-store demand pulled from the run's source sessions.
   * When the user just enters a price and leaves qty at planned, this is
   * what we send as `storeSplits`. Without this the client would dump
   * the entire qty into "first store" and the user would re-allocate by
   * hand on every line.
   */
  const demandBySku = useMemo(() => {
    const m = new Map<string, Array<{ storeId: string; qty: string }>>();
    for (const d of run.perStoreDemand ?? []) {
      const arr = m.get(d.skuId) ?? [];
      arr.push({ storeId: d.storeId, qty: d.qty });
      m.set(d.skuId, arr);
    }
    return m;
  }, [run.perStoreDemand]);

  /**
   * SKU → its recorded splits, for the same reason as `demandBySku`.
   *
   * Every row was calling `run.splits.filter(sp => sp.skuId === ...)`,
   * so an 87-item run with ~260 splits did ~22,000 comparisons per
   * render — and the 6-second poll hands back fresh arrays every time,
   * so this recomputed on a timer even when nothing had changed.
   */
  const splitsBySku = useMemo(() => {
    const m = new Map<string, typeof run.splits>();
    for (const sp of run.splits) {
      const arr = m.get(sp.skuId) ?? [];
      arr.push(sp);
      m.set(sp.skuId, arr);
    }
    return m;
  }, [run.splits]);

  /**
   * Inverse of `demandBySku` — `storeId → [{ skuId, qty }]`. Powers the
   * per-store view added 2026-05-05. We compute it once here rather
   * than per-render of each store card so a 10-store run with 50 SKUs
   * does ~500 ops instead of 5,000.
   */
  const skusByStore = useMemo(() => {
    const m = new Map<string, Array<{ skuId: string; qty: string }>>();
    for (const d of run.perStoreDemand ?? []) {
      const arr = m.get(d.storeId) ?? [];
      arr.push({ skuId: d.skuId, qty: d.qty });
      m.set(d.storeId, arr);
    }
    return m;
  }, [run.perStoreDemand]);

  /**
   * View toggle (added 2026-05-05).
   *
   * Default = `aggregate`: the current per-SKU list with inline +/- and
   * ✓-save buttons. Recording purchases happens here.
   *
   * `perStore` = read-only planning view: groups SKUs by store so the
   * purchaser can see "Store A wants 2kg apples + 1kg onions, Store B
   * wants 3kg apples". Useful before walking the market — they know
   * what to total in their head.
   *
   * Choice persists per-user via localStorage so a purchaser who
   * prefers per-store doesn't have to re-toggle every time.
   *
   * Toggle hidden when the run only spans 1 store (per-store view
   * would be a single card with the same content as aggregate).
   */
  // M3.27 (2026-05-18): third view mode — "perVendor". Same persistence
  // key; old values 'aggregate'|'perStore' continue to round-trip.
  type ViewMode = 'aggregate' | 'perStore' | 'perVendor' | 'perCategory';
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('compass.run.viewMode');
      if (saved === 'perStore' || saved === 'perVendor' || saved === 'perCategory') return saved;
      return 'aggregate';
    } catch {
      return 'aggregate';
    }
  });
  const setViewModePersist = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem('compass.run.viewMode', mode);
    } catch {
      /* localStorage disabled / quota — non-fatal */
    }
  };
  // Distinct stores referenced by perStoreDemand. Falls back to splits
  // (legacy runs without perStoreDemand still have splits once they
  // start delivering).
  const demandStoreIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of run.perStoreDemand ?? []) ids.add(d.storeId);
    if (ids.size === 0) {
      for (const sp of run.splits) ids.add(sp.storeId);
    }
    return [...ids];
  }, [run.perStoreDemand, run.splits]);
  // Distinct suppliers (including unassigned bucket) across the run's
  // SKUs — gates whether the vendor toggle is worth showing.
  const distinctSupplierCount = useMemo(() => {
    if (!run.supplierBySku) return 0;
    const ids = new Set<string>();
    for (const it of run.items) {
      ids.add(run.supplierBySku[it.skuId]?.id ?? '__unassigned__');
    }
    return ids.size;
  }, [run.items, run.supplierBySku]);
  const distinctCategoryCount = useMemo(() => {
    const ids = new Set<string>();
    for (const it of run.items) {
      ids.add(skuById.get(it.skuId)?.categoryId ?? '__uncategorized__');
    }
    return ids.size;
  }, [run.items, skuById]);
  // M3.27 (2026-05-18): showing perStore needs ≥2 stores; showing
  // perVendor needs ≥2 supplier buckets (including unassigned). The
  // toggle itself shows when either condition holds — even if only
  // one of the two extra views would be useful, the user can pick.
  const showPerStore = demandStoreIds.length >= 2;
  const showPerVendor = distinctSupplierCount >= 2;
  const showPerCategory = distinctCategoryCount >= 2;
  // 2026-07-06: `amending` (a super-admin correcting a finished run)
  // reuses the exact purchasing edit surface — same views, same inline
  // qty/price/add/undo — so the phase gates below treat it like
  // purchasing. `editingPhase` = "records are editable right now".
  const editingPhase = run.status === 'purchasing' || run.status === 'amending';
  const plannedOrEditing = run.status === 'planned' || editingPhase;
  const showViewToggle = plannedOrEditing && (showPerStore || showPerVendor || showPerCategory);

  /**
   * Search + filter over the in-run list.
   *
   * The pre-run preview has had both since the accordion landed; the
   * moment the run STARTS they disappeared, and the 87-row list the
   * purchaser actually works from had no way to find anything. Same
   * matcher as the preview (lib/searchMatch), so a Russian speaker
   * typing "молоко" finds a SKU whose display name resolved to Chinese.
   *
   * Not persisted: a query is about the stall you are standing at, and
   * reopening the page to a list silently hiding 80 rows is worse than
   * retyping four characters.
   */
  const [itemQuery, setItemQuery] = useState('');
  const [itemFilter, setItemFilter] = useState<ItemFilter>('all');
  const itemTokens = useMemo(() => normalizeQuery(itemQuery) ?? [], [itemQuery]);
  const itemCounts = useMemo(
    () => countByStatus(run.items, (it) => it.status),
    [run.items],
  );
  const itemListView = useMemo(
    (): ItemView<ActiveRun['items'][number]> => ({
      nameOf: (it) => {
        const sku = skuById.get(it.skuId);
        return sku ? productName(sku) : it.skuId;
      },
      supplierNameOf: (it) => run.supplierBySku?.[it.skuId]?.name ?? null,
      // Other-language names, so the row is findable in whichever
      // language the purchaser thinks in — mirrors the preview's
      // lineHaystack.
      extraHaystackOf: (it) => Object.values(skuById.get(it.skuId)?.names ?? {}),
      statusOf: (it) => it.status,
      idOf: (it) => it.skuId,
    }),
    [skuById, productName, run.supplierBySku],
  );
  const visibleRunItems = useMemo(
    () => visibleItems(run.items, itemListView, { tokens: itemTokens, filter: itemFilter }),
    [run.items, itemListView, itemTokens, itemFilter],
  );

  return (
    <div className="flex flex-col gap-2">
      {/* View-mode toggle — M3.28 (2026-05-18): dropped the "Aggregate"
          chip per user feedback. The aggregate view is the editing
          surface where price/qty get recorded; it's not a "view" the
          user thinks about toggling INTO. They wanted just two view
          chips ("by store", "by vendor") that they can toggle ON to
          see the run grouped, and toggle OFF to return to the
          edit-able aggregate. Tapping a selected chip deselects it.
          Shown only when the run actually spans multiple stores OR
          multiple vendor buckets — a single-store / single-vendor run
          short-circuits straight to aggregate. */}
      {showViewToggle ? (
        <div className="border-b border-[var(--c-divider)] bg-[var(--c-bg)] py-1">
          {/* variant="toggles" (2026-07-30): tapping the lit chip clears
              it back to aggregate, so this is a set of independent toggle
              buttons — not a tab group. As a tablist with nothing selected
              (the default aggregate state) it was invalid ARIA. */}
          <ChipBar variant="toggles" ariaLabel={i18n.t('run.view.ariaLabel')}>
            {showPerStore ? (
              <Chip
                selected={viewMode === 'perStore'}
                onClick={() =>
                  setViewModePersist(viewMode === 'perStore' ? 'aggregate' : 'perStore')
                }
              >
                {i18n.t('run.view.perStore')}
              </Chip>
            ) : null}
            {showPerVendor ? (
              <Chip
                selected={viewMode === 'perVendor'}
                onClick={() =>
                  setViewModePersist(viewMode === 'perVendor' ? 'aggregate' : 'perVendor')
                }
              >
                {i18n.t('run.view.perVendor')}
              </Chip>
            ) : null}
            {showPerCategory ? (
              <Chip
                selected={viewMode === 'perCategory'}
                onClick={() =>
                  setViewModePersist(viewMode === 'perCategory' ? 'aggregate' : 'perCategory')
                }
              >
                {/* 2026-07-26: was a hard-coded Chinese literal, so
                    ru/uz/en operators saw 按类型 in an otherwise
                    translated chip bar. */}
                {i18n.t('run.view.perCategory')}
              </Chip>
            ) : null}
          </ChipBar>
        </div>
      ) : null}
      {showViewToggle && viewMode === 'perStore' && showPerStore ? (
        <PerStoreView
          run={run}
          storeById={storeById}
          skuById={skuById}
          productName={productName}
          skusByStore={skusByStore}
        />
      ) : null}
      {showViewToggle && viewMode === 'perVendor' && showPerVendor ? (
        <PerVendorView
          onSetPaymentMethod={onSetPaymentMethod}
          paymentBusySkuId={paymentBusySkuId}
          run={run}
          skuById={skuById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          priceInThousands={priceInThousands}
          onTogglePriceUnit={onTogglePriceUnit}
          savingSkuId={savingSkuId}
          demandBySku={demandBySku}
          onSavePurchaseInline={onSavePurchaseInline}
          onMarkNa={onMarkNa}
          onOpenAdvancedPurchase={onOpenAdvancedPurchase}
          onEditPurchased={onEditPurchased}
          onUnmark={onUnmark}
          onMarkExtraStatus={onMarkExtraStatus}
          onRecordExtraExpense={onRecordExtraExpense}
        />
      ) : null}
      {showViewToggle && viewMode === 'perCategory' && showPerCategory ? (
        <PerCategoryView
          onSetPaymentMethod={onSetPaymentMethod}
          paymentBusySkuId={paymentBusySkuId}
          run={run}
          skuById={skuById}
          categoryById={categoryById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          priceInThousands={priceInThousands}
          onTogglePriceUnit={onTogglePriceUnit}
          savingSkuId={savingSkuId}
          demandBySku={demandBySku}
          onSavePurchaseInline={onSavePurchaseInline}
          onMarkNa={onMarkNa}
          onOpenAdvancedPurchase={onOpenAdvancedPurchase}
          onEditPurchased={onEditPurchased}
          onUnmark={onUnmark}
        />
      ) : null}
      {(!showViewToggle ||
        viewMode === 'aggregate' ||
        (viewMode === 'perStore' && !showPerStore) ||
        (viewMode === 'perVendor' && !showPerVendor) ||
        (viewMode === 'perCategory' && !showPerCategory)) &&
      plannedOrEditing && run.items.length > 0 ? (
        <Card>
          {/* M2.1: SectionLabel (was 3-line ad-hoc div). Same visual,
              standardised primitive so every section eyebrow renders
              identically across the app. */}
          {/* Was run.label.pendingFraction — "{done}/{total} 待办" fed
              with the PENDING count. Two problems. An x/y fraction
              beside a section header is read as "x of y done", so a
              fresh run announced "87/87" (i.e. finished) and a nearly
              finished one announced "3/87"; and the sibling
              confirmedFraction twenty lines below uses the identical
              shape counting the other way. It also folded "bought" and
              "couldn't get" into one number, so the two outcomes that
              matter most at handover were indistinguishable.

              Three counts, each labelled, counting in the direction the
              word implies. */}
          <SectionLabel
            meta={i18n.t('run.label.itemsProgress', {
              bought: run.items.filter((i) => i.status === 'purchased').length,
              na: run.items.filter((i) => i.status === 'unavailable').length,
              pending: run.items.filter((i) => i.status === 'pending').length,
            })}
          >
            {i18n.t('run.section.items')}
          </SectionLabel>
          {/* Search + filter, only once the list is long enough to need
              them. Below that threshold the whole list is on one screen
              and the controls would cost more rows than they save. */}
          {run.items.length >= 8 ? (
            <>
              <div className="px-4 pb-1.5">
                <input
                  type="search"
                  value={itemQuery}
                  onChange={(e) => setItemQuery(e.target.value)}
                  placeholder={i18n.t('run.search.itemsPlaceholder')}
                  aria-label={i18n.t('run.search.itemsPlaceholder')}
                  className="h-9 w-full rounded-[var(--r-pill)] border border-[var(--c-divider)] bg-[var(--c-surface-2)] px-3 text-body outline-none focus:border-[var(--c-action)]"
                />
              </div>
              <ChipBar
                className="pt-0"
                ariaLabel={i18n.t('run.filter.ariaLabel')}
              >
                <Chip
                  selected={itemFilter === 'all'}
                  onClick={() => setItemFilter('all')}
                >
                  {i18n.t('run.filter.all', { n: itemCounts.all })}
                </Chip>
                <Chip
                  selected={itemFilter === 'pending'}
                  onClick={() => setItemFilter('pending')}
                >
                  {i18n.t('run.filter.pending', { n: itemCounts.pending })}
                </Chip>
                {itemCounts.unavailable > 0 ? (
                  <Chip
                    selected={itemFilter === 'unavailable'}
                    onClick={() => setItemFilter('unavailable')}
                  >
                    {i18n.t('run.filter.unavailable', {
                      n: itemCounts.unavailable,
                    })}
                  </Chip>
                ) : null}
              </ChipBar>
            </>
          ) : null}
          {visibleRunItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-body text-[var(--c-fg-muted)]">
              {i18n.t('run.filter.noMatch')}
            </p>
          ) : null}
          <ul className="flex flex-col" role="list">
            {visibleRunItems.map((it) => {
              const sku = skuById.get(it.skuId);
              const skuName = sku ? productName(sku) : it.skuId.slice(0, 8);
              // M3.52: pluck this SKU's recorded splits for the
              // per-store breakdown chips shown under purchased rows.
              // Pending rows fall back to planned demand inside the
              // row component — so we pass both regardless of status.
              const actualSplits = (splitsBySku.get(it.skuId) ?? []).map((sp) => ({
                storeId: sp.storeId,
                qty: sp.qty,
                unitPrice: sp.unitPrice,
                paymentMethod: sp.paymentMethod,
              }));
              return (
                <PurchaseRow
                  key={it.skuId}
                  onTogglePriceUnit={onTogglePriceUnit}
                  item={it}
                  skuName={skuName}
                  unit={unitLabel(sku?.unit)}
                  step={sku?.step ?? '0.1'}
                  demand={demandBySku.get(it.skuId) ?? []}
                  storeById={storeById}
                  actualSplits={actualSplits}
                  isMultiStoreRun={demandStoreIds.length > 1}
                  lastPrice={run.lastPriceBySku?.[it.skuId] ?? null}
                  lastPriceObservedAt={run.lastPriceObservedAtBySku?.[it.skuId] ?? null}
                  i18n={i18n}
                  priceInThousands={priceInThousands}
                  saving={savingSkuId === it.skuId}
                  onSave={onSavePurchaseInline}
                  onMarkNa={onMarkNa}
                  onEdit={onEditPurchased}
                  onUnmark={onUnmark}
                  onOpenAdvanced={onOpenAdvancedPurchase}
                  onSetPaymentMethod={onSetPaymentMethod}
                  paymentBusy={paymentBusySkuId === it.skuId}
                />
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* M3.31 (2026-05-18, A.1): "其他物品" footer for the aggregate edit
          surface too. Until this fix, staff-typed extras (structured
          M3.16-C entries) disappeared from the purchaser's view the
          moment a run started — they only existed in the preview
          UI. Now they sit right under the per-SKU list so the
          purchaser sees them while recording buys. */}
      {(!showViewToggle ||
        viewMode === 'aggregate' ||
        (viewMode === 'perStore' && !showPerStore) ||
        (viewMode === 'perVendor' && !showPerVendor) ||
        (viewMode === 'perCategory' && !showPerCategory)) &&
      plannedOrEditing ? (
        <RunExtrasCard
          sessionExtrasByStore={run.sessionExtrasByStore}
          sessionNotesByStore={run.sessionNotesByStore}
          storeById={storeById}
          i18n={i18n}
          editable={editingPhase}
          onMarkExtraStatus={onMarkExtraStatus}
          onRecordExtraExpense={onRecordExtraExpense}
        />
      ) : null}

      {/* M3.44 (2026-05-22): off-catalog expenses card. Rendered in
          aggregate / perVendor view BELOW the items + extras
          sections. Always visible (read-only in non-purchasing
          phases) so the manager can see "what off-plan was spent"
          from any page state. */}
      {(!showViewToggle ||
        viewMode === 'aggregate' ||
        (viewMode === 'perStore' && !showPerStore) ||
        (viewMode === 'perVendor' && !showPerVendor) ||
        (viewMode === 'perCategory' && !showPerCategory)) &&
      (editingPhase || (run.expenses?.length ?? 0) > 0) ? (
        <ExpensesCard
          expenses={run.expenses}
          storeById={storeById}
          i18n={i18n}
          priceInThousands={priceInThousands}
          editable={editingPhase}
          onRemove={onRemoveExpense}
          onOpenExpense={onOpenExpense}
        />
      ) : null}

      {/* A trip where nothing could be bought reaches `delivering` with
          zero splits, so the store list below renders nothing at all and
          the screen went blank. Say so instead — and note that Finish is
          reachable, which it now is (see allStoresConfirmed in
          RunPage.tsx). */}
      {run.status === 'delivering' && involvedStoreIds.length === 0 ? (
        <Card>
          <EmptyState
            title={i18n.t('run.empty.nothingToDeliver')}
            description={i18n.t('run.empty.nothingToDeliverBody')}
          />
        </Card>
      ) : null}

      {run.status === 'delivering' && involvedStoreIds.length > 0 ? (
        <Card>
          {/* M2.1: SectionLabel (was ad-hoc eyebrow div). */}
          <SectionLabel
            meta={i18n.t('run.label.confirmedFraction', {
              done: involvedStoreIds.filter((sid) =>
                run.splits.filter((sp) => sp.storeId === sid).every((sp) => !!sp.confirmedAt),
              ).length,
              total: involvedStoreIds.length,
            })}
          >
            {i18n.t('run.section.stores')}
          </SectionLabel>
          <ul className="flex flex-col" role="list">
            {involvedStoreIds.map((storeId) => {
              const store = storeById.get(storeId);
              const storeName = store?.name ?? storeId.slice(0, 8);
              const splitsHere = run.splits.filter((sp) => sp.storeId === storeId);
              const allDelivered = splitsHere.every((sp) => !!sp.deliveredAt);
              const allConfirmed = splitsHere.every((sp) => !!sp.confirmedAt);
              const stage: 'pending' | 'delivered' | 'confirmed' = allConfirmed
                ? 'confirmed'
                : allDelivered
                  ? 'delivered'
                  : 'pending';
              // M1.9-fix (2026-05-07): subtitle/badge label were rendered
              // as raw English. The delivery store list is the
              // purchaser's main during-run view; non-English users were
              // seeing English on every store row.
              const subtitle = i18n.t(('run.deliveryStage.' + stage) as Parameters<typeof i18n.t>[0]);
              const tappable = stage !== 'confirmed';
              /* UIUX-B1 (2026-07-06): stage Badge deleted — the meta line
                 already states the stage (UI-2: status once per row);
                 the L1 delivery-stage rail lands in the B3 row pass. */
              const inner = (
                <>
                  <span className="shrink-0 truncate text-body font-semibold">{storeName}</span>
                  <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
                    {i18n.t('run.label.itemsCount', { n: splitsHere.length })} · {subtitle}
                  </span>
                </>
              );
              return (
                <li
                  key={storeId}
                  className="border-b border-[var(--c-divider)] last:border-b-0"
                >
                  {tappable ? (
                    <button
                      type="button"
                      onClick={() =>
                        stage === 'pending'
                          ? onDeliverStore(storeId, storeName)
                          : onRecallStore(storeId, storeName)
                      }
                      className="flex w-full items-center gap-2 px-4 py-2 text-left active:bg-[var(--c-surface-2)]"
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-2 px-4 py-2 text-[var(--c-fg-muted)]">
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* M1.11: dropped run.banner.readyToStart — its content
          ("Tap Start Purchase when ready") is already conveyed by the
          MainButton sitting at the bottom of the page in the same state.
          The banner just took up vertical space without adding info. */}
    </div>
  );
}

/**
 * Per-store view (added 2026-05-05).
 *
 * Read-only planning aid for multi-store runs. Groups SKUs by store
 * so a purchaser can mentally tally "Store A wants 2kg apples, Store
 * B wants 3kg apples" before walking the market. The actual purchase
 * recording happens in the Aggregate view — keeping a single source
 * of truth avoids the "did I already buy these?" footgun the agent
 * flagged in the audit.
 *
 * Each store card shows:
 *   - Store name + a 12px "X SKUs · total Y units" line
 *   - One row per SKU: name + qty for that store
 *
 * Sort: stores by name; SKUs within store by sortIndex (which
 * mirrors the catalog order in OrderPage).
 */

/**
 * PreviewSummaryCard — the "ready to plan" summary on RunPage with
 * three views (M1.5, 2026-05-06):
 *
 *   - Overall    : flat SKU list (legacy behavior, unchanged shape).
 *   - By store   : each store's combined order list, with a "Copy
 *                  list" button per store.
 *   - By supplier: each preferred-vendor's preparation list, with a
 *                  per-store breakdown under each item and a "Copy →
 *                  send to vendor" button that produces a localized
 *                  text template the operator can paste into the
 *                  vendor's chat. SKUs with no preferred vendor land
 *                  in an "Unassigned" group.
 *
 * The user explicitly asked for both views: "采购员发给摊位 让他们提前
 * 按每个店铺的采购量分开准备好". This is the per-supplier flow. The
 * per-store view is the inverse — useful when the chain owner wants
 * to see "what is each store getting today" at a glance.
 *
 * Persists view choice in localStorage so the operator's preference
 * survives page navigation.
 */
/**
 * 2026-07-26: dropped the third 'overall' tab.
 *
 * It rendered `plannedItems.slice(0, 8)` as name + qty — no price, no
 * total, no store, no stall, no sort, no tap target, and (since M1.11)
 * not even a "+N more". Every number in it was a strict SUBSET of the
 * by-store tab, which shows the same SKUs split per store PLUS unit
 * price, line total, per-store total and the extras. And it was the
 * DEFAULT, so the first thing anyone saw was the least informative of
 * the three.
 *
 * What was worth building is not a third way to slice the list — it is
 * the run-wide facts (what will this cost, what is missing) — so those
 * moved into a header that renders above whichever view is active. Same
 * call the team already made in M3.28 when it removed the "aggregate"
 * chip from the in-run view.
 */
type PreviewView = 'byStore' | 'bySupplier';
const PREVIEW_VIEW_STORAGE_KEY = 'compass.runPreview.view';

// PreviewLine / PreviewStoreGroup / PreviewSupplierGroup moved to
// ../types (2026-07-26) so runs/lib/shareText.ts can consume them
// without importing this component.

/** Nearest scrollable ancestor — Shell's `<main class="overflow-y-auto">`. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

function previewLineTotal(qty: string, unitPrice: string | null): number | null {
  if (!unitPrice) return null;
  const qtyNum = Number(qty);
  const priceNum = Number(unitPrice);
  if (!Number.isFinite(qtyNum) || !Number.isFinite(priceNum)) return null;
  return qtyNum * priceNum;
}

function addPreviewLine(group: PreviewStoreGroup, line: PreviewLine): void {
  group.items.push(line);
  if (line.total === null) group.unknownCount += 1;
  else group.total += line.total;
}

export function PreviewSummaryCard({
  preview,
  skuById,
  productName,
  i18n,
  toast,
}: {
  preview: {
    // M3.24 (2026-05-18): nullable when the caller didn't ask for a
    // specific date — preview then spans every approved-not-in-run
    // session regardless of order_date.
    date: string | null;
    sessions: ReadonlyArray<{ id: string; storeId: string; storeName?: string; orderDate?: string }>;
    plannedItems: ReadonlyArray<{ skuId: string; qty: string }>;
    perStoreDemand: ReadonlyArray<{
      storeId: string;
      storeName: string;
      skuId: string;
      qty: string;
    }>;
    supplierBySku: Record<string, {
      id: string;
      name: string;
      contactPhone: string | null;
      contactTg: string | null;
      defaultPrice?: string | null;
      lastSeenPrice?: string | null;
      estimatedUnitPrice?: string | null;
    } | null>;
    lastPurchasePriceBySku?: Record<string, string>;
    perStoreBudgets?: ReadonlyArray<{
      storeId: string;
      storeName: string;
      estimatedTotal: string;
      unknownPriceCount: number;
    }>;
    /** M1.8: per-store concatenated session notes ("其他物品", legacy). */
    sessionNotesByStore?: Record<string, string>;
    /** M3.16-C: per-store structured extras. */
    sessionExtrasByStore?: Record<
      string,
      Array<{ name: string; qty: string; unit: string; note?: string; sessionId?: string; idx?: number }>
    >;
  };
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  toast: ReturnType<typeof useToast>;
}) {
  const [view, setView] = useState<PreviewView>(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem(PREVIEW_VIEW_STORAGE_KEY);
      // The whitelist already excluded 'overall', so a stored value from
      // before that tab was removed falls through to the default below —
      // no migration needed.
      if (v === 'byStore' || v === 'bySupplier') return v;
    }
    // Adaptive, NOT hard-coded to bySupplier. That view is built purely
    // from preview.supplierBySku, which the server fills only from
    // `sku_supplier_links WHERE is_preferred` — and the sole writer of
    // that table is run.setSkuPreferredSupplier, one SKU at a time, by
    // hand. An org that has never done that assignment would land on a
    // single "unassigned" bucket: worse than the tab we just deleted,
    // with the fallback gone. So default there only once it will
    // actually have structure.
    const planned = preview.plannedItems;
    if (planned.length === 0) return 'byStore';
    const assigned = planned.filter((it) => preview.supplierBySku[it.skuId]).length;
    return assigned / planned.length >= 0.5 ? 'bySupplier' : 'byStore';
  });
  // M1.6 #1: when set, the VendorPickerSheet is open for this skuId.
  const [vendorPickerFor, setVendorPickerFor] = useState<string | null>(null);
  /**
   * Single-open accordion, one open key per view (2026-07-26).
   *
   * Was `Record<string, boolean>` initialised to `{}` with
   * `isCollapsed = map[key] === true` — i.e. everything EXPANDED by
   * default and any number open at once, the exact opposite of what was
   * asked for. Two separate keys rather than one shared one so flipping
   * byStore ↔ bySupplier and back does not lose your place, and so a
   * store id can never be the "open" key of the supplier view.
   */
  const [openStore, setOpenStore] = useState<string | null>(null);
  const [openSupplier, setOpenSupplier] = useState<string | null>(null);

  /**
   * Keep the tapped header where the finger left it.
   *
   * Opening group 7 also CLOSES whichever group was open. If that one sat
   * above the current scroll position its panel — easily 900px for a
   * twenty-row store at two lines each — vanishes from above the
   * viewport while scrollTop stays put, so the header the purchaser just
   * pressed jumps off the top of the screen and they are suddenly looking
   * at a different part of the list.
   *
   * Measure the header before the state change, re-measure after layout,
   * and push the difference back into the scroller. `scrollIntoView` is
   * deliberately not used: it fights the sticky page header and behaves
   * differently in the Telegram WebView. iOS WKWebView has no scroll
   * anchoring of its own, so nothing does this for us.
   */
  const scrollAnchor = useRef<{ el: HTMLElement; top: number } | null>(null);
  const anchorOn = (el: HTMLElement | null): void => {
    if (el) scrollAnchor.current = { el, top: el.getBoundingClientRect().top };
  };
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    if (!anchor) return;
    scrollAnchor.current = null;
    const scroller = scrollParentOf(anchor.el);
    if (!scroller) return;
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (delta !== 0) scroller.scrollTop += delta;
  });
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const currentUnitLabel = useCallback(
    (unit: string | null | undefined): string => {
      if (!unit) return '';
      const canonical = unit.toLowerCase();
      const key = ('unit.' + canonical) as Parameters<typeof i18n.t>[0];
      const localized = i18n.t(key);
      return localized === key ? unit : localized;
    },
    [i18n],
  );
  const currentSkuName = useCallback(
    (item: { names: Record<string, string> | null | undefined }): string => {
      const names = item.names ?? {};
      return (
        names[i18n.locale] ??
        names.en ??
        names.ru ??
        names.zh ??
        names.uz ??
        Object.values(names)[0] ??
        '—'
      );
    },
    [i18n.locale],
  );
  /**
   * Persist only what the user CHOSE, never the computed default.
   *
   * This used to be a `useEffect` on [view], which wrote on first mount
   * — so the adaptive default got stored as if it were a preference and
   * every later visit read it back instead of re-deriving. Caught on a
   * real dev instance (2026-07-26): the very first page load happened
   * with no approved orders, the initializer correctly fell back to
   * byStore for an empty preview, that got persisted, and afterwards the
   * card stayed on byStore even at 84/93 SKUs assigned to stalls, where
   * bySupplier is the whole point. The old constant default hid this;
   * an adaptive one cannot afford it.
   */
  const chooseView = useCallback((v: PreviewView) => {
    setView(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PREVIEW_VIEW_STORAGE_KEY, v);
    }
  }, []);

  const storeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of preview.perStoreDemand) m.set(row.storeId, row.storeName);
    for (const row of preview.perStoreBudgets ?? []) m.set(row.storeId, row.storeName);
    for (const row of preview.sessions) {
      if (row.storeName) m.set(row.storeId, row.storeName);
    }
    return m;
  }, [preview.perStoreBudgets, preview.perStoreDemand, preview.sessions]);

  const estimatedPriceForSku = useCallback(
    (skuId: string): string | null =>
      preview.lastPurchasePriceBySku?.[skuId] ??
      preview.supplierBySku[skuId]?.estimatedUnitPrice ??
      null,
    [preview.lastPurchasePriceBySku, preview.supplierBySku],
  );

  const ensurePreviewStoreGroup = useCallback(
    (m: Map<string, PreviewStoreGroup>, storeId: string, storeName?: string) => {
      let cur = m.get(storeId);
      if (!cur) {
        cur = {
          storeId,
          storeName: storeName ?? storeNameById.get(storeId) ?? storeId.slice(0, 8),
          items: [],
          total: 0,
          unknownCount: 0,
        };
        m.set(storeId, cur);
      } else if (storeName && cur.storeName === storeId.slice(0, 8)) {
        cur.storeName = storeName;
      }
      return cur;
    },
    [storeNameById],
  );

  const byStore = useMemo(() => {
    const m = new Map<string, PreviewStoreGroup>();
    for (const row of preview.perStoreDemand) {
      const sku = skuById.get(row.skuId);
      const unitPrice = estimatedPriceForSku(row.skuId);
      const group = ensurePreviewStoreGroup(m, row.storeId, row.storeName);
      const supplier = preview.supplierBySku[row.skuId] ?? null;
      addPreviewLine(group, {
        id: `sku:${row.storeId}:${row.skuId}`,
        kind: 'sku',
        skuId: row.skuId,
        name: sku ? productName(sku) : row.skuId.slice(0, 8),
        qty: row.qty,
        unit: currentUnitLabel(sku?.unit),
        unitPrice,
        total: previewLineTotal(row.qty, unitPrice),
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
      });
    }

    for (const [storeId, extras] of Object.entries(preview.sessionExtrasByStore ?? {})) {
      const group = ensurePreviewStoreGroup(m, storeId);
      for (const ex of extras) {
        addPreviewLine(group, {
          id: `extra:${storeId}:${ex.sessionId ?? ''}:${ex.idx ?? group.items.length}:${ex.name}`,
          kind: 'extra',
          skuId: null,
          name: ex.name,
          qty: ex.qty,
          unit: ex.unit,
          unitPrice: null,
          total: null,
          note: ex.note,
        });
      }
    }

    for (const [storeId, note] of Object.entries(preview.sessionNotesByStore ?? {})) {
      const trimmed = note.trim();
      if (!trimmed) continue;
      ensurePreviewStoreGroup(m, storeId).legacyNote = trimmed;
    }

    // Order within a store: catalog SKUs before off-catalog extras, then
    // by stall, then by name. Grouping by stall inside the store is the
    // cheap way to get the visual clustering a nested store→stall→item
    // tree would give, without a second level of headers eating ~28px
    // each on a 375px screen. Unassigned SKUs sink to the bottom of the
    // SKU block so the "no stall" exception reads as a tail, not noise
    // sprinkled through the list.
    //
    // This also fixes a real defect: `perStoreDemand` comes from an
    // unordered orderItemsV query, so the previous row order was
    // Postgres heap order.
    for (const g of m.values()) {
      g.items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'sku' ? -1 : 1;
        const an = a.supplierName ?? null;
        const bn = b.supplierName ?? null;
        if (an !== bn) {
          if (an === null) return 1;
          if (bn === null) return -1;
          const bySupplierName = an.localeCompare(bn);
          if (bySupplierName !== 0) return bySupplierName;
        }
        return a.name.localeCompare(b.name);
      });
    }

    return [...m.values()]
      .filter((g) => g.items.length > 0 || g.legacyNote)
      .sort((a, b) => a.storeName.localeCompare(b.storeName));
  }, [
    ensurePreviewStoreGroup,
    currentUnitLabel,
    estimatedPriceForSku,
    preview.perStoreDemand,
    preview.sessionExtrasByStore,
    preview.sessionNotesByStore,
    preview.supplierBySku,
    productName,
    skuById,
  ]);

  const bySupplier = useMemo(() => {
    const buckets = new Map<string, PreviewSupplierGroup>();
    const ensureSupplier = (
      supplierId: string | null,
      supplierName: string,
      contactPhone: string | null,
      contactTg: string | null,
    ) => {
      const key = supplierId ?? '__unassigned__';
      let cur = buckets.get(key);
      if (!cur) {
        cur = {
          supplierId,
          supplierName,
          contactPhone,
          contactTg,
          stores: [],
          total: 0,
          unknownCount: 0,
        };
        buckets.set(key, cur);
      }
      return cur;
    };
    const ensureSupplierStore = (
      supplier: PreviewSupplierGroup,
      storeId: string,
      storeName: string,
    ) => {
      let cur = supplier.stores.find((s) => s.storeId === storeId);
      if (!cur) {
        cur = {
          storeId,
          storeName,
          items: [],
          total: 0,
          unknownCount: 0,
        };
        supplier.stores.push(cur);
      }
      return cur;
    };

    for (const store of byStore) {
      for (const line of store.items) {
        // Read the id the LINE already carries rather than re-resolving
        // from preview.supplierBySku — one resolve point means the two
        // views cannot drift about where an item comes from.
        const supplier =
          line.kind === 'sku' && line.supplierId
            ? preview.supplierBySku[line.skuId!] ?? null
            : null;
        const bucket = ensureSupplier(
          supplier?.id ?? null,
          supplier?.name ?? i18n.t('run.previewSupplier.unassigned'),
          supplier?.contactPhone ?? null,
          supplier?.contactTg ?? null,
        );
        const storeBucket = ensureSupplierStore(bucket, store.storeId, store.storeName);
        addPreviewLine(storeBucket, line);
        if (line.total === null) bucket.unknownCount += 1;
        else bucket.total += line.total;
      }
      if (store.legacyNote) {
        const bucket = ensureSupplier(
          null,
          i18n.t('run.previewSupplier.unassigned'),
          null,
          null,
        );
        ensureSupplierStore(bucket, store.storeId, store.storeName).legacyNote =
          store.legacyNote;
      }
    }

    return [...buckets.values()]
      .map((b) => ({
        ...b,
        stores: b.stores.sort((a, b2) => a.storeName.localeCompare(b2.storeName)),
      }))
      .sort((a, b) => {
        if (a.supplierId === null) return 1;
        if (b.supplierId === null) return -1;
        return a.supplierName.localeCompare(b.supplierName);
      });
  }, [byStore, i18n, preview.supplierBySku]);

  /**
   * Run-wide facts for the header. Derived from the CLIENT byStore memo,
   * deliberately not from the server's `preview.perStoreBudgets`: that is
   * built from order_items_v alone, so it cannot see `extrasJson`, while
   * `addPreviewLine` counts extras as unpriced. The two disagree about
   * the same store today — one of them had to win, and only the client
   * number matches what is rendered directly underneath it.
   *
   * Counts are of DISTINCT items, not of rows: a SKU three stores want
   * is one thing to buy, and "无摊位 3" meaning one SKU across three
   * stores would be a lie. Extras key on name+unit, the same merge rule
   * the vendor share-text uses.
   */
  const previewStats = useMemo(
    () =>
      computePreviewStats(byStore, (skuId) => Boolean(preview.supplierBySku[skuId])),
    [byStore, preview.supplierBySku],
  );

  const groupMoneyMeta = (total: number, unknownCount: number): string => {
    const parts = [
      `${i18n.t('run.preview.groupTotal')} ${formatMoney(total)} ${currency}`,
    ];
    if (unknownCount > 0) {
      parts.push(i18n.t('run.preview.unknownPrices', { n: unknownCount }));
    }
    return parts.join(' · ');
  };

  const lineFormula = (line: PreviewLine): string => {
    const qtyUnit = `${formatQty(line.qty)} ${line.unit}`.trim();
    if (line.total === null || !line.unitPrice) {
      // UIUX-B1: state "price unknown" once, not twice in one formula.
      return `${qtyUnit} · ${i18n.t('run.preview.priceUnknown')}`;
    }
    return `${qtyUnit} * ${formatMoney(line.unitPrice)} = ${formatMoney(line.total)}`;
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for environments without clipboard API.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      return true;
    } catch {
      return false;
    }
  };

  const shareOrCopyText = async (text: string): Promise<void> => {
    const copied = await copyToClipboard(text);
    let opened = false;
    const url = shareLink({ url: '', text });
    try {
      const tg = getTg();
      if (tg?.openTelegramLink) {
        tg.openTelegramLink(url);
        opened = true;
      } else if (typeof window !== 'undefined') {
        opened = window.open(url, '_blank', 'noopener,noreferrer') !== null;
      }
    } catch {
      opened = false;
    }
    if (opened) {
      toast.success(
        i18n.t(copied ? 'run.previewShare.openedWithCopy' : 'run.previewShare.opened'),
      );
      haptic('success');
      return;
    }
    if (copied) {
      toast.success(i18n.t('run.previewStore.copied'));
      haptic('success');
      return;
    }
    toast.error(i18n.t('common.error'));
  };

  /**
   * Catalog + i18n bindings handed to the pure builders in
   * `../lib/shareText`. The builders themselves live outside this
   * component so the vendor-vs-store disclosure boundary is unit-tested
   * (see runs/lib/__tests__/shareText.test.ts) rather than eyeballed.
   */
  // Deliberately NOT memoized. `useI18n` returns a memo keyed on the
  // resolved locale, so its identity does NOT change when a lazily
  // imported catalog chunk lands — `useEnsureLocale` re-renders via a
  // state counter instead. A useMemo here would therefore freeze
  // extrasLabel / notesLabel at whatever the fallback catalog said on
  // first render (English, if the user's locale chunk was still in
  // flight on bazaar LTE) for the entire mount. Rebuilding this small
  // object each render restores the live read the old inline closures
  // had; the builders themselves only run on a button tap.
  const shareDeps: ShareTextDeps = {
    resolveSku: (skuId: string) => {
      const sku = skuById.get(skuId);
      if (!sku) return null;
      return { name: currentSkuName(sku), unit: currentUnitLabel(sku.unit) };
    },
    extrasLabel: i18n.t('order.extras.label'),
    notesLabel: i18n.t('order.notes.label'),
  };

  const buildStoreText = (group: PreviewStoreGroup): string =>
    buildStoreTextPure(group, shareDeps);

  const buildSupplierText = (group: PreviewSupplierGroup): string =>
    buildSupplierTextPure(group, shareDeps);

  const buildAllVendorsText = (): string =>
    bySupplier.map((b) => buildSupplierText(b)).filter(Boolean).join('\n\n');

  // Pruned during render rather than in an effect: the derived value is
  // correct on the first frame, and the next toggle overwrites the stale
  // state anyway. Groups really do come and go under the user — the 6s
  // poll re-derives both memos, and reassigning a SKU's stall can empty
  // a bucket outright.
  /**
   * Name filter — the escape hatch collapse-by-default needed.
   *
   * Groups start shut, which is what was asked for, but it took away the
   * one thing the old always-open list was good at: scrolling to find a
   * SKU. "This stall is out of tomatoes, I bought them three stalls
   * later" means reaching a row inside a group you are not standing in
   * front of, and with everything collapsed the only way was to open
   * nine groups one at a time.
   *
   * While a query is active the accordion is bypassed — every surviving
   * group renders open, because the point of searching is to see the
   * hits, not to then go tapping for them.
   */
  const [filterText, setFilterText] = useState('');
  const filterTokens = useMemo(() => normalizeQuery(filterText) ?? [], [filterText]);
  const filtering = filterTokens.length > 0;
  // Other-language names for the SKU behind a line, so a Russian speaker
  // finds a row whose display name resolved to Chinese.
  const lineHaystack = useCallback(
    (line: PreviewLine) => {
      const sku = line.skuId ? skuById.get(line.skuId) : null;
      return sku ? Object.values(sku.names ?? {}) : [];
    },
    [skuById],
  );
  const visibleByStore = useMemo(
    () => filterStoreGroups(byStore, filterTokens, lineHaystack),
    [byStore, filterTokens, lineHaystack],
  );
  const visibleBySupplier = useMemo(
    () => filterSupplierGroups(bySupplier, filterTokens, lineHaystack),
    [bySupplier, filterTokens, lineHaystack],
  );
  const matchCount =
    view === 'byStore' ? countStoreLines(visibleByStore) : countSupplierLines(visibleBySupplier);
  const totalCount =
    view === 'byStore' ? countStoreLines(byStore) : countSupplierLines(bySupplier);

  const storeKeys = byStore.map((g) => g.storeId);
  const supplierKeys = bySupplier.map((b) => b.supplierId ?? '__unassigned__');
  const openStoreKey = pruneOpen(openStore, storeKeys);
  const openSupplierKey = pruneOpen(openSupplier, supplierKeys);

  const renderLine = (
    line: PreviewLine,
    index: number,
    opts?: { editableSupplier?: boolean; showSupplier?: boolean },
  ) => {
    const rowBg = index % 2 === 0 ? 'bg-[var(--c-surface)]' : 'bg-[var(--c-surface-2)]';
    const formulaTone =
      line.total === null ? 'text-[var(--c-warning-fg)]' : 'text-[var(--c-fg-muted)]';
    const nameNode =
      opts?.editableSupplier && line.kind === 'sku' && line.skuId ? (
        <button
          type="button"
          onClick={() => setVendorPickerFor(line.skuId)}
          className="press min-w-0 max-w-full text-left text-[var(--c-fg)]"
          title={i18n.t('run.previewSupplier.changeVendor')}
        >
          {line.name}
        </button>
      ) : (
        <span className="min-w-0 max-w-full text-[var(--c-fg)]">{line.name}</span>
      );
    /**
     * Two-line form for the by-store view (2026-07-26). The stall is the
     * group header in the by-supplier view, so repeating it per row there
     * would be noise — hence the opt-in.
     *
     * Layout rule: only the product name and the stall name may truncate.
     * Every number is `shrink-0`, because a half-visible price is worse
     * than a wrapped one — the purchaser reads these back to a vendor.
     */
    if (opts?.showSupplier) {
      const stallTone = line.supplierId
        ? 'text-[var(--c-fg-muted)]'
        : 'text-[var(--c-warning-fg)]';
      const qtyUnit = `${formatQty(line.qty)} ${line.unit}`.trim();
      return (
        <li key={line.id} className={`px-2 py-1.5 ${rowBg}`}>
          <div className="flex min-w-0 items-baseline gap-2 text-body">
            {line.kind === 'extra' ? (
              <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-warn-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--c-warning-fg)] ring-hairline">
                {i18n.t('order.extras.label')}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">{line.name}</span>
            <span
              className={`shrink-0 font-mono text-label font-semibold tabular-nums ${
                line.total === null ? 'text-[var(--c-warning-fg)]' : 'text-[var(--c-fg)]'
              }`}
            >
              {line.total === null
                ? i18n.t('run.preview.priceUnknown')
                : formatMoney(line.total)}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-label">
            {/* flex-1, not a max-w cap: the stall name is the field this
                whole row exists to surface, so it should take whatever the
                number leaves rather than give up at 45% while half the row
                sits empty. The emoji is decorative and aria-hidden — this
                row repeats once per item, and a screen reader announcing
                "shopping trolley" before every stall name is noise. */}
            <span className={`min-w-0 flex-1 truncate ${stallTone}`}>
              {line.kind === 'extra' ? null : (
                <>
                  <span aria-hidden>{line.supplierId ? '🛒' : '❓'}</span>{' '}
                  {line.supplierId
                    ? line.supplierName ?? ''
                    : i18n.t('run.previewSupplier.unassigned')}
                </>
              )}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
              {line.unitPrice ? `${qtyUnit} × ${formatMoney(line.unitPrice)}` : qtyUnit}
            </span>
          </div>
          {line.note ? (
            <div className="mt-0.5 whitespace-pre-wrap text-label leading-snug text-[var(--c-fg-muted)]">
              {line.note}
            </div>
          ) : null}
        </li>
      );
    }

    return (
      <li
        key={line.id}
        className={`px-2 py-1.5 ${rowBg}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-body">
            {line.kind === 'extra' ? (
              <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-warn-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--c-warning-fg)] ring-hairline">
                {i18n.t('order.extras.label')}
              </span>
            ) : null}
            {nameNode}
            <span className={`min-w-0 font-mono text-label tabular-nums ${formulaTone}`}>
              {lineFormula(line)}
            </span>
          </div>
          {line.note ? (
            <div className="mt-0.5 whitespace-pre-wrap text-label leading-snug text-[var(--c-fg-muted)]">
              {line.note}
            </div>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <Card className="-mx-2 overflow-hidden rounded-[var(--r-capsule)]">
      <CardHeader className="px-3 pt-3">
        <CardTitle>{i18n.t('run.section.readyToPlan')}</CardTitle>
        <Badge>{i18n.t('run.label.sessionsCount', { n: preview.sessions.length })}</Badge>
      </CardHeader>
      {/* Segmented control — sticky horizontal pill bar, same visual
          language as ScopeTab in MemberPermissionsSheet. Two taps here
          (was three until 'overall' was dropped — see PreviewView), both
          instant: all the data is already in `preview`. */}
      {/* Q7(a): the one piece of real content the deleted "plan run"
          sheet carried. Inline, not modal — it is information about what
          the start button does, and information belongs next to the
          thing it describes rather than in a dialog you have to dismiss
          before you can act on it. */}
      {preview.sessions.length > 0 ? (
        <div className="px-3 pt-2">
          <Banner
            tone="warn"
            title={i18n.t('run.banner.planLockWarning', { n: preview.sessions.length })}
          />
        </div>
      ) : null}
      {/* Search sits ABOVE the view chips: it applies to both, and with
          every group collapsed it is the primary way to reach a row. */}
      <div className="px-3 pt-1">
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={i18n.t('order.search.placeholder')}
            aria-label={i18n.t('order.search.placeholder')}
            className="h-9 min-w-0 flex-1 rounded-[var(--r-pill)] border border-[var(--c-divider)] bg-[var(--c-surface-2)] px-3 text-body outline-none focus:border-[var(--c-action)]"
          />
          {filtering ? (
            <span className="shrink-0 font-mono text-label tabular-nums text-[var(--c-fg-muted)]">
              {i18n.t('run.preview.filterMatch', { n: matchCount, total: totalCount })}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex gap-1 px-3 pb-2 pt-1">
        {(['byStore', 'bySupplier'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => chooseView(v)}
            className={
              'press flex-1 rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline ' +
              (view === v
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
            }
          >
            {i18n.t(
              v === 'byStore' ? 'run.previewView.byStore' : 'run.previewView.bySupplier',
            )}
          </button>
        ))}
      </div>

      {/* Run-wide header. Renders above BOTH views on purpose — "what
          will this cost" and "what is missing" are facts about the whole
          list, not a third way to group it, so burying them behind a tab
          nobody had a reason to open is what made the old 'overall' tab
          worthless. Same reasoning the per-store block already used: it
          was never gated on `view` either. */}
      {byStore.length > 0 ? (
        <div className="border-t border-[var(--c-divider)] px-3 py-2">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <SectionLabel padded={false}>
              {i18n.t('run.preview.estimateTitle')}
            </SectionLabel>
            {/* Coverage, NOT a spend estimate. Both the server and the
                client drop unpriced lines from the sum entirely, and run
                expenses (transport, porters, market fees) do not exist
                until the run is finished — so this number is
                systematically low. It says "at least", never "≈", and
                must never read as "cash to bring". */}
            <span className="text-label text-[var(--c-fg-muted)]">
              {i18n.t('run.preview.coverage', {
                known: previewStats.known,
                total: previewStats.total,
                money: formatMoney(previewStats.knownTotal, currency),
              })}
            </span>
          </div>

          {/* Exceptions. "No stall" is tappable because there IS a fix
              path — the by-stall view buckets them under "unassigned",
              where tapping a SKU name opens the vendor picker. Nobody
              could find that before. "No reference price" is a plain
              count: there is no view that isolates those yet, and a chip
              that goes nowhere is worse than a number. */}
          {previewStats.noSupplier > 0 || previewStats.total > previewStats.known ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {previewStats.noSupplier > 0 ? (
                <button
                  type="button"
                  onClick={() => chooseView('bySupplier')}
                  // 36px, not the 44px the purchase row's ✓ gets. Measured
                  // at 22px on a real instance, which is too small to hit
                  // reliably one-handed — but this is a once-per-run
                  // navigation shortcut whose worst failure is "tap again",
                  // not a control that commits money hundreds of times a
                  // trip. The static counter beside it matches so the row
                  // reads as one band.
                  className="press flex min-h-9 items-center rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-2.5 text-label text-[var(--c-warning-fg)] ring-hairline"
                >
                  {i18n.t('run.preview.noSupplierCount', { n: previewStats.noSupplier })}
                </button>
              ) : null}
              {previewStats.total > previewStats.known ? (
                <span className="flex min-h-9 items-center rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-2.5 text-label text-[var(--c-warning-fg)]">
                  {i18n.t('run.preview.unknownPrices', {
                    n: previewStats.total - previewStats.known,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            {byStore.map((g) => (
              <div key={g.storeId} className="flex items-baseline gap-2 text-body-sm">
                <span className="min-w-0 flex-1 truncate">{g.storeName}</span>
                {g.unknownCount > 0 ? (
                  <span className="shrink-0 text-label text-[var(--c-warning-fg)]">
                    {i18n.t('run.preview.unknownPrices', { n: g.unknownCount })}
                  </span>
                ) : null}
                <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg)]">
                  {formatMoney(g.total, currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {filtering && matchCount === 0 ? (
        <div className="px-4 py-6 text-center">
          <div className="text-body font-semibold text-[var(--c-fg)]">
            {i18n.t('order.search.noMatches.title')}
          </div>
          <div className="mt-1 text-label text-[var(--c-fg-muted)]">
            {i18n.t('order.search.noMatches.description')}
          </div>
        </div>
      ) : null}

      {view === 'byStore' ? (
        <div className="px-2 py-2">
          {visibleByStore.map((g) => {
            // While filtering, every surviving group is open: the point
            // of searching is to see the hits, not to go tapping for them.
            const open = filtering || isOpen(openStoreKey, g.storeId);
            const storeNote = g.legacyNote;
            const panelId = `preview-store-${g.storeId}`;
            return (
            <section
              key={g.storeId}
              className="border-t border-[var(--c-divider)] py-2 first:border-t-0 first:pt-0 last:pb-0"
            >
              {/* The toggle is a real <button> and the send action is its
                  SIBLING. It used to be a role="button" div with the send
                  <button> nested inside it — invalid HTML, a screen-reader
                  trap, and the reason that send handler needed a
                  stopPropagation() to avoid also toggling the group. */}
              {/* Padding lives on the BUTTON, not the wrapper: putting it
                  on the wrapper made the visible grey band 46px tall while
                  the actual hit area was the ~35px text block inside it,
                  so the band's edges were dead pixels that look tappable.
                  No aria-label either — it would override the name and
                  meta below as the accessible name, leaving every header
                  announcing an identical "Expand". aria-expanded already
                  carries the state. */}
              <div className="mb-1.5 flex items-center gap-2 rounded-[var(--r-utility)] bg-[var(--c-surface-2)] pr-2">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={(e) => {
                    anchorOn(e.currentTarget);
                    setOpenStore((o) => toggleOpen(o, g.storeId));
                  }}
                  className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-utility)] px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--c-ring)]"
                >
                  <span aria-hidden className="shrink-0 font-mono text-label text-[var(--c-fg-muted)]">
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="block min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-[var(--c-fg)]">
                      {g.storeName}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-label tabular-nums text-[var(--c-fg-muted)]">
                      {groupMoneyMeta(g.total, g.unknownCount)}
                    </span>
                  </span>
                </button>
                {/* M2.1: Button component (was raw <button>). */}
                <Button
                  variant="pearl"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void shareOrCopyText(buildStoreText(g))}
                >
                  {i18n.t('run.previewShare.sendList')}
                </Button>
              </div>
              <ul
                id={panelId}
                className={open ? 'overflow-hidden rounded-[var(--r-utility)]' : 'hidden'}
              >
                {g.items.map((line, idx) => renderLine(line, idx, { showSupplier: true }))}
              </ul>
              {/* M1.8 / M3.16-C: surface the staff's "其他物品" requests
                  inline. M3.16-C structured extras render as one row
                  per item; legacy free-text notes (pre-M3.16) appended
                  underneath in italic. The purchaser scrolls the by-
                  store view at the market and needs requests right
                  next to the SKU list. */}
              {open && storeNote ? (
                <div className="mt-1.5 rounded-[var(--r-utility)] bg-[var(--c-warn-bg)] px-2 py-1.5">
                  <SectionLabel padded={false}>
                    {i18n.t('order.extras.label')}
                  </SectionLabel>
                  {storeNote ? (
                    <div className="mt-1 whitespace-pre-wrap text-body-sm italic leading-snug text-[var(--c-fg-muted)]">
                      {storeNote}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
            );
          })}
        </div>
      ) : null}

      {view === 'bySupplier' ? (
        <div className="px-2 py-2">
          {/* M3.26 (2026-05-18): top-of-list "copy everything" button so
              the purchaser can paste one block into a notebook and walk
              the bazaar. Hidden when there's nothing to copy (no rows
              with qty > 0 in any bucket). */}
          {bySupplier.length > 0 ? (
            <div className="mb-2 flex justify-end">
              <Button
                variant="pearl"
                size="sm"
                onClick={() => void shareOrCopyText(buildAllVendorsText())}
              >
                {i18n.t('run.previewShare.sendAll')}
              </Button>
            </div>
          ) : null}
          {visibleBySupplier.map((b) => {
            const supplierKey = b.supplierId ?? '__unassigned__';
            const open = filtering || isOpen(openSupplierKey, supplierKey);
            const panelId = `preview-supplier-${supplierKey}`;
            return (
            <section
              key={supplierKey}
              className="border-t border-[var(--c-divider)] py-2 first:border-t-0 first:pt-0 last:pb-0"
            >
              {/* Real <button> + sibling send action — see the by-store
                  header for why the nested-button version had to go. */}
              <div className="mb-1.5 flex items-center gap-2 rounded-[var(--r-utility)] bg-[var(--c-surface-2)] pr-2">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={(e) => {
                    anchorOn(e.currentTarget);
                    setOpenSupplier((o) => toggleOpen(o, supplierKey));
                  }}
                  className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-utility)] px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--c-ring)]"
                >
                  <span aria-hidden className="shrink-0 font-mono text-label text-[var(--c-fg-muted)]">
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="block min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-[var(--c-fg)]">
                      {b.supplierId ? `🛒 ${b.supplierName}` : `❓ ${b.supplierName}`}
                    </span>
                    {b.contactTg ? (
                      <span className="block text-label text-[var(--c-fg-muted)]">@{b.contactTg}</span>
                    ) : b.contactPhone ? (
                      <span className="block text-label text-[var(--c-fg-muted)]">{b.contactPhone}</span>
                    ) : null}
                    <span className="mt-0.5 block truncate font-mono text-label tabular-nums text-[var(--c-fg-muted)]">
                      {groupMoneyMeta(b.total, b.unknownCount)}
                    </span>
                  </span>
                </button>
                {/* M3.26 (2026-05-18): copy button is now visible for the
                    unassigned bucket too — items to buy individually
                    deserve their own paste — and switched to the same
                    pearl style + "Copy list" label as the by-store
                    view per the user's UX preference. */}
                <Button
                  variant="pearl"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void shareOrCopyText(buildSupplierText(b))}
                >
                  {i18n.t('run.previewShare.sendList')}
                </Button>
              </div>
              {open && !b.supplierId ? (
                <p className="mb-1.5 px-2 text-label text-[var(--c-fg-muted)]">
                  {i18n.t('run.previewSupplier.unassignedHint')}
                </p>
              ) : null}
              {/* M1.7-fix2 (2026-05-07): pivot to store-major within
                  each supplier — same data, cleaner layout. The
                  previous SKU-major rendering put the store name
                  under EVERY SKU even when consecutive items went to
                  the same store, doubling vertical space and visually
                  fragmenting what's really one store's pickup list.
                  Now each store is a small section header with its
                  items underneath — matches the copy template format
                  the user asked for in the previous round. */}
              <div id={panelId} className={open ? 'flex flex-col gap-2' : 'hidden'}>
                {b.stores.map((store) => (
                  <div key={store.storeId}>
                    <div className="mb-1 flex items-baseline gap-2 px-2 text-label font-semibold text-[var(--c-fg-muted)]">
                      <span>{store.storeName}</span>
                      <span className="ml-auto font-mono font-normal tabular-nums">
                        {groupMoneyMeta(store.total, store.unknownCount)}
                      </span>
                    </div>
                    <ul className="overflow-hidden rounded-[var(--r-utility)]">
                      {store.items.map((line, idx) =>
                        renderLine(line, idx, { editableSupplier: true }),
                      )}
                    </ul>
                    {store.legacyNote ? (
                      <div className="mt-1.5 rounded-[var(--r-utility)] bg-[var(--c-warn-bg)] px-2 py-1.5">
                        <SectionLabel padded={false}>
                          {i18n.t('order.notes.label')}
                        </SectionLabel>
                        <div className="mt-1 whitespace-pre-wrap text-body-sm leading-snug text-[var(--c-fg-muted)]">
                          {store.legacyNote}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
            );
          })}
        </div>
      ) : null}
      {vendorPickerFor ? (
        <VendorPickerSheet
          skuId={vendorPickerFor}
          skuName={
            skuById.get(vendorPickerFor)
              ? productName(skuById.get(vendorPickerFor)!)
              : vendorPickerFor.slice(0, 8)
          }
          currentSupplierId={preview.supplierBySku[vendorPickerFor]?.id ?? null}
          onClose={() => setVendorPickerFor(null)}
          i18n={i18n}
          toast={toast}
        />
      ) : null}
    </Card>
  );
}

/**
 * VendorPickerSheet (M1.6 #1, 2026-05-06).
 *
 * Reuses the existing supplier list (loaded fresh per open so it
 * reflects new suppliers without restarts). Calls
 * `run.setSkuPreferredSupplier` and invalidates the preview query so
 * the by-supplier view re-aggregates.
 */
function VendorPickerSheet({
  skuId,
  skuName,
  currentSupplierId,
  onClose,
  i18n,
  toast,
}: {
  skuId: string;
  skuName: string;
  currentSupplierId: string | null;
  onClose: () => void;
  i18n: ReturnType<typeof useI18n>;
  toast: ReturnType<typeof useToast>;
}) {
  const utils = trpc.useUtils();
  const suppliersQuery = trpc.admin.supplierList.useQuery();
  // M1.21: route the error toast through the i18n-aware helper. The
  // server returns localized message keys (e.g. `run.errors.xxx`);
  // dumping `err.message` raw shows the key string to non-EN users.
  const errToast = useErrToast();
  const setSupplier = trpc.run.setSkuPreferredSupplier.useMutation({
    onSuccess: (_data, vars) => {
      void utils.run.previewCreatable.invalidate();
      toast.success(
        i18n.t(
          vars.supplierId
            ? 'run.previewSupplier.assigned'
            : 'run.previewSupplier.cleared',
        ),
      );
      onClose();
    },
    onError: errToast('common.error'),
  });

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && !setSupplier.isPending && onClose()}
      title={i18n.t('run.previewSupplier.pickVendorTitle')}
      description={skuName}
    >
      <div className="flex flex-col gap-2 py-3">
        <p className="px-1 text-label text-[var(--c-fg-muted)]">
          {i18n.t('run.previewSupplier.pickVendorHint')}
        </p>
        <button
          type="button"
          onClick={() => setSupplier.mutate({ skuId, supplierId: null })}
          disabled={setSupplier.isPending}
          className={
            'press flex items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left ring-hairline ' +
            (currentSupplierId === null
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
              : 'bg-[var(--c-surface-2)]')
          }
        >
          <span className="text-body">
            {i18n.t('run.previewSupplier.clearVendor')}
          </span>
          {currentSupplierId === null ? <span aria-hidden>✓</span> : null}
        </button>
        {(suppliersQuery.data ?? []).map((sup) => {
          const selected = sup.id === currentSupplierId;
          return (
            <button
              key={sup.id}
              type="button"
              onClick={() => setSupplier.mutate({ skuId, supplierId: sup.id })}
              disabled={setSupplier.isPending}
              className={
                'press flex items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left ring-hairline ' +
                (selected
                  ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                  : 'bg-[var(--c-surface-2)]')
              }
            >
              <div className="min-w-0">
                <div className="text-body font-medium">{sup.name}</div>
                {sup.contactTg ? (
                  <div className="mt-0.5 text-label opacity-80">@{sup.contactTg}</div>
                ) : sup.contactPhone ? (
                  <div className="mt-0.5 text-label opacity-80">{sup.contactPhone}</div>
                ) : null}
              </div>
              {selected ? <span aria-hidden>✓</span> : null}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

export function RunSessionsCard({
  sessions,
  storeById,
  i18n,
  ejecting,
  onEject,
}: {
  sessions: NonNullable<ActiveRun['sessions']>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  i18n: ReturnType<typeof useI18n>;
  ejecting: boolean;
  onEject: (session: NonNullable<ActiveRun['sessions']>[number]) => void;
}) {
  return (
    <Card>
      <SectionLabel meta={i18n.t('run.sessions.meta', { n: sessions.length })}>
        {i18n.t('run.section.sessions')}
      </SectionLabel>
      <ul className="flex flex-col" role="list">
        {sessions.map((sessionRow) => {
          const storeName =
            storeById.get(sessionRow.storeId)?.name ?? sessionRow.storeId.slice(0, 8);
          const submitter =
            sessionRow.submittedByDisplayName ?? i18n.t('run.sessions.unknownSubmitter');
          return (
            <li
              key={sessionRow.id}
              className="flex items-center gap-2 border-b border-[var(--c-divider)] px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-body font-semibold">{storeName}</span>
                  <span className="shrink-0 text-label text-[var(--c-fg-muted)]">
                    {submitter}
                  </span>
                </div>
                <div className="truncate text-label text-[var(--c-fg-muted)]">
                  {i18n.t(
                    sessionRow.extrasCount > 0
                      ? 'run.sessions.stats'
                      : 'run.sessions.statsNoExtras',
                    {
                      items: sessionRow.itemCount,
                      qty: formatQty(sessionRow.totalQty),
                      extras: sessionRow.extrasCount,
                    },
                  )}
                </div>
              </div>
              <Button
                variant="pearl"
                size="sm"
                disabled={ejecting}
                loading={ejecting}
                onClick={() => onEject(sessionRow)}
              >
                {i18n.t('run.action.ejectSession')}
              </Button>
            </li>
          );
        })}
      </ul>
      {/* UIUX-B1: the permanent eject-rules footer is gone — the eject
          ConfirmSheet body already states the exact constraint at the
          moment it matters. */}
    </Card>
  );
}

