/**
 * Grouped run views + the shared row leaf — extracted verbatim from
 * RunPage.tsx (Phase 4 step 4, FRONTEND_AUDIT_2026-07.md run-domain
 * split).
 *
 *   - GroupCardHeader   one header chrome for all grouped cards
 *   - PerStoreView      delivering checklist, grouped by store
 *   - PerVendorView     purchase view grouped by supplier stall
 *   - PerCategoryView   purchase view grouped by catalog category
 *   - RunExtrasCard     per-store 其他物品 extras during the run
 *   - ExpensesCard      off-catalog run expenses
 *   - PurchaseRow       THE row leaf all purchase views share
 *
 * All props-driven; mutations stay in RunPage and arrive as callbacks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Card, NumberInput, SectionLabel } from '@compass/ui';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatQty, toQtyInput } from '../../../lib/format';
import { useI18n, useUnitLabel } from '../../../hooks/useI18n';
import { toDisplayPrice, fromDisplayPrice } from '../lib/priceMath';
import {
  priceRowState,
  priceAgeDays,
  collapsedCommit,
  AGING_DAYS,
  GUESS_DAYS,
} from '../lib/priceState';
import { proportionalSplitQty } from '../lib/splitQty';
import type { ActiveRun } from '../types';

/**
 * GroupCardHeader — the "group title + right-aligned count·qty meta"
 * strip at the top of every grouped run card. Was typed byte-identically
 * in PerStoreView + PerVendorView and divergently in PerCategoryView's
 * <summary> (py-2, count inlined after the name). One copy now; the
 * per-category view renders it inside its <summary> so the collapse
 * affordance is preserved while the chrome matches the other two views.
 */
function GroupCardHeader({ title, meta }: { title: ReactNode; meta: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-4 py-1.5 text-label text-[var(--c-fg-muted)]">
      <span className="truncate text-body font-semibold text-[var(--c-fg)]">{title}</span>
      <span className="tabular-nums">{meta}</span>
    </div>
  );
}

export function PerStoreView({
  run,
  storeById,
  skuById,
  productName,
  skusByStore,
}: {
  run: ActiveRun;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  skusByStore: Map<string, Array<{ skuId: string; qty: string }>>;
}) {
  const i18n = useI18n();
  // 2026-07-26: these views rendered the RAW canonical unit code
  // ("kg" / "bunch" / "pcs") while the preview card next door rendered
  // the localized label ("公斤" / "把"), so the same SKU read two
  // different ways on two screens. useUnitLabel has existed since
  // M3.34 and falls back to the raw string for exotic free-text units.
  const unitLabel = useUnitLabel();
  // Indexed once. Every row was doing run.items.find(...), which on an
  // 87-item run is ~7,600 comparisons per render, repeated whenever the
  // 6-second poll hands back a new array.
  const itemBySku = useMemo(
    () => new Map(run.items.map((it) => [it.skuId, it])),
    [run.items],
  );
  const orderedStores = useMemo(() => {
    const ids = [...skusByStore.keys()];
    ids.sort((a, b) => {
      const an = storeById.get(a)?.name ?? a;
      const bn = storeById.get(b)?.name ?? b;
      return an.localeCompare(bn);
    });
    return ids;
  }, [skusByStore, storeById]);

  return (
    <div className="flex flex-col gap-2">
      {orderedStores.map((storeId) => {
        const store = storeById.get(storeId);
        const rows = skusByStore.get(storeId) ?? [];
        const totalQty = rows.reduce((s, r) => s + Number(r.qty || 0), 0);
        const storeNote = run.sessionNotesByStore?.[storeId]?.trim();
        return (
          <Card key={storeId}>
            <GroupCardHeader
              title={store?.name ?? storeId.slice(0, 8)}
              meta={i18n.t('run.label.skuCountAndQty', {
                n: rows.length,
                qty: formatQty(String(totalQty)),
              })}
            />
            {/* M3.31 (2026-05-18, A.1): "其他物品" surfaces here in three
                forms — M3.16-C structured extras (one row per item) +
                M1.8 legacy free-text note + the section eyebrow. Until
                this fix, the active-run views only rendered the legacy
                storeNote; the structured extras (the format staff have
                actually been using since M3.16-C) silently disappeared
                between approval and the purchaser's screen. */}
            {(() => {
              const extras = run.sessionExtrasByStore?.[storeId] ?? [];
              if (extras.length === 0 && !storeNote) return null;
              return (
                // Flattened (2026-07-05): was a second rounded-card +
                // ring-hairline box nested inside this store Card
                // (card-in-card). Now a full-bleed tinted band — the
                // warn background alone delineates it; the extra ring +
                // radius were redundant seams. px-4 aligns with the card
                // header/rows above and below.
                <div className="mb-2 mt-1 bg-[var(--c-warn-bg)] px-4 py-2">
                  <SectionLabel padded={false}>
                    {i18n.t('order.extras.label')}
                  </SectionLabel>
                  {extras.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {extras.map((e, idx) => (
                        <li
                          key={`${e.name}-${idx}`}
                          className="flex items-baseline justify-between gap-2 text-body-sm"
                        >
                          <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">
                            {e.name}
                            {e.note ? (
                              <span className="ml-1 text-[var(--c-fg-muted)]">· {e.note}</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                            {e.qty} {unitLabel(e.unit)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {storeNote ? (
                    <div className="mt-1 whitespace-pre-wrap text-body-sm italic leading-snug text-[var(--c-fg-muted)]">
                      {storeNote}
                    </div>
                  ) : null}
                </div>
              );
            })()}
            <ul className="flex flex-col" role="list">
              {rows
                .map((r) => ({
                  ...r,
                  sku: skuById.get(r.skuId),
                  // Look up the run-level item so we can show the status
                  // (purchased / pending / unavailable) of the rolled-up
                  // SKU. Even read-only the purchaser wants to know
                  // they've already bought half the rows.
                  runItem: itemBySku.get(r.skuId) ?? null,
                }))
                .sort((a, b) => {
                  const ai = a.sku?.id ? 0 : 1;
                  const bi = b.sku?.id ? 0 : 1;
                  if (ai !== bi) return ai - bi;
                  const an = a.sku ? productName(a.sku) : a.skuId;
                  const bn = b.sku ? productName(b.sku) : b.skuId;
                  const byName = an.localeCompare(bn);
                  return byName !== 0 ? byName : a.skuId.localeCompare(b.skuId);
                })
                .map((r) => {
                  const skuName = r.sku ? productName(r.sku) : r.skuId.slice(0, 8);
                  const status = r.runItem?.status ?? 'pending';
                  const tone =
                    status === 'purchased'
                      ? 'text-[var(--c-success)]'
                      : status === 'unavailable'
                        ? 'text-[var(--c-danger)]'
                        : 'text-[var(--c-fg-muted)]';
                  const mark =
                    status === 'purchased' ? '✓' : status === 'unavailable' ? '✗' : '·';
                  return (
                    <li
                      key={r.skuId}
                      className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
                    >
                      <span aria-hidden className={`shrink-0 text-body ${tone}`}>
                        {mark}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body">{skuName}</span>
                      <span className="shrink-0 font-mono text-body tabular-nums text-[var(--c-fg-muted)]">
                        {formatQty(r.qty)} {unitLabel(r.sku?.unit)}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Per-vendor read-only view for an ACTIVE run (M3.27, 2026-05-18).
 *
 * Mirrors `PerStoreView`'s look-and-feel but groups by the preferred
 * supplier resolved server-side (`run.supplierBySku`). SKUs with no
 * preferred link land in an "Unassigned" bucket so single-buy items
 * stay visible. Rows show the same status mark (·/✓/✗) the per-store
 * view uses, so the purchaser can see at a glance which stalls still
 * have outstanding work.
 *
 * Read-only: actual purchase recording happens in the aggregate view.
 * Switching to per-vendor at the bazaar is for "what do I still need
 * from stall X" planning, not for editing.
 */
export function PerVendorView({
  run,
  skuById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  onTogglePriceUnit,
  savingSkuId,
  demandBySku,
  onSavePurchaseInline,
  onMarkNa,
  onOpenAdvancedPurchase,
  onEditPurchased,
  onUnmark,
  onMarkExtraStatus,
  onRecordExtraExpense,
  onSetPaymentMethod,
  paymentBusySkuId,
}: {
  run: ActiveRun;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  savingSkuId: string | null;
  /** M3.43 (2026-05-22): per-vendor view now reuses the SAME inline
   *  PurchaseRow component the aggregate view uses, so the purchaser
   *  can type qty + price + ✓ Save directly inside the vendor card —
   *  no more sheet-roundtrip per row. The original M3.36 tap-row →
   *  sheet pattern is preserved as the FALLBACK for rows whose qty
   *  diverges from the planned demand (handled by PurchaseRow
   *  internally via onOpenAdvanced). */
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  demandBySku: Map<string, Array<{ storeId: string; qty: string }>>;
  onSavePurchaseInline: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    /**
     * Where the purchase actually happened. Only the by-stall view can
     * know this (the purchaser is working one stall at a time), so the
     * other views omit it and the handler falls back to null rather
     * than guessing from the SKU's preferred supplier.
     */
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
  onOpenAdvancedPurchase: (item: ActiveRun['items'][number]) => void;
  onEditPurchased: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  /** M3.37 (Wave2 #5): tap-to-cycle extras status. */
  onMarkExtraStatus: (
    sessionId: string,
    extraIndex: number,
    status: 'pending' | 'bought' | 'unavailable',
  ) => void;
  onRecordExtraExpense: (
    storeId: string,
    extra: { name: string; qty: string; unit: string; note?: string },
  ) => void;
  onSetPaymentMethod: (
    item: ActiveRun['items'][number],
    next: 'cash' | 'transfer',
  ) => void;
  paymentBusySkuId: string | null;
}) {
  // See PerStoreView — raw unit codes leaked here too.
  const unitLabel = useUnitLabel();
  // Indexed once each — every row did run.items.find(...) plus
  // run.splits.filter(...), which on an 87-item run with ~260 splits is
  // roughly 30,000 comparisons per render, recomputed whenever the
  // 6-second poll returns fresh array identities.
  const itemBySku = useMemo(
    () => new Map(run.items.map((it) => [it.skuId, it])),
    [run.items],
  );
  const splitsBySku = useMemo(() => {
    const m = new Map<string, typeof run.splits>();
    for (const sp of run.splits) {
      const arr = m.get(sp.skuId) ?? [];
      arr.push(sp);
      m.set(sp.skuId, arr);
    }
    return m;
  }, [run.splits]);
  // M3.52: run-level multi-store flag. PurchaseRow uses this to decide
  // whether to render per-store chips on EVERY row of the run (true
  // when the run spans ≥2 stores) — without this single-store-demand
  // rows in a multi-store run had no store label and looked ambiguous.
  // Falls back to splits for legacy runs missing perStoreDemand.
  const isMultiStoreRun = useMemo(() => {
    const ids = new Set<string>();
    for (const d of run.perStoreDemand ?? []) ids.add(d.storeId);
    if (ids.size === 0) {
      for (const sp of run.splits) ids.add(sp.storeId);
    }
    return ids.size > 1;
  }, [run.perStoreDemand, run.splits]);

  // Bucket run.items by their preferred supplier (id) or '__unassigned__'.
  const buckets = useMemo(() => {
    type Bucket = {
      supplierId: string | null;
      supplierName: string;
      items: Array<{ skuId: string; plannedQty: string; status: string }>;
    };
    const m = new Map<string, Bucket>();
    for (const it of run.items) {
      const sup = run.supplierBySku?.[it.skuId] ?? null;
      const key = sup?.id ?? '__unassigned__';
      const bucket = m.get(key) ?? {
        supplierId: sup?.id ?? null,
        supplierName: sup?.name ?? i18n.t('run.previewSupplier.unassigned'),
        items: [],
      };
      bucket.items.push({
        skuId: it.skuId,
        plannedQty: it.plannedQty,
        status: it.status,
      });
      m.set(key, bucket);
    }
    // Real vendors first (alphabetical), unassigned last.
    return [...m.values()].sort((a, b) => {
      if (a.supplierId && !b.supplierId) return -1;
      if (!a.supplierId && b.supplierId) return 1;
      return a.supplierName.localeCompare(b.supplierName);
    });
  }, [run.items, run.supplierBySku, i18n]);

  return (
    <div className="flex flex-col gap-2">
      {buckets.map((b) => {
        const totalQty = b.items.reduce((s, r) => s + Number(r.plannedQty || 0), 0);
        return (
          <Card key={b.supplierId ?? '__unassigned__'}>
            {/* 🛒/❓ encode assigned-vs-unassigned supplier state (UI-1:
                state-carrying, not decorative) — the Phase 6 sweep
                decides whether to swap them for text/color. */}
            <GroupCardHeader
              title={b.supplierId ? `🛒 ${b.supplierName}` : `❓ ${b.supplierName}`}
              meta={i18n.t('run.label.skuCountAndQty', {
                n: b.items.length,
                qty: formatQty(String(totalQty)),
              })}
            />
            <ul className="flex flex-col" role="list">
              {b.items
                .map((r) => ({ ...r, sku: skuById.get(r.skuId) }))
                .sort((a, c) => {
                  // Sorted by NAME only, deliberately.
                  //
                  // This used to lead with status (pending 0 /
                  // purchased 1 / unavailable 2) to "keep what's left
                  // on top". On a touch screen that is a trap: saving
                  // the top row drops it into the resolved bucket and
                  // pulls every row below it up by one, under a thumb
                  // already travelling toward the next ✓. The second
                  // tap lands on a row that was somewhere else when the
                  // finger started moving, and on this list a tap
                  // commits money. "Show me only what's left" is now a
                  // filter chip the purchaser chooses, not something
                  // the list does underneath them.
                  //
                  // (The comment here also claimed the aggregate view
                  // sorted by sortIndex. There is no sortIndex on a run
                  // item — the field exists only on admin catalogue
                  // rows — and that view had no sort at all until it
                  // got runs/lib/itemList.ts.)
                  const ai = a.sku ? 0 : 1;
                  const bi = c.sku ? 0 : 1;
                  if (ai !== bi) return ai - bi;
                  const an = a.sku ? productName(a.sku) : a.skuId;
                  const bn = c.sku ? productName(c.sku) : c.skuId;
                  const byName = an.localeCompare(bn);
                  // Total order — equal names must not swap on re-render.
                  return byName !== 0 ? byName : a.skuId.localeCompare(c.skuId);
                })
                .map((r) => {
                  const skuName = r.sku ? productName(r.sku) : r.skuId.slice(0, 8);
                  // M3.43 (2026-05-22): reuse PurchaseRow inline so the
                  // purchaser can record qty+price+✓ at the stall without
                  // a sheet roundtrip. PurchaseRow handles all three row
                  // states (pending input, purchased read-only with edit,
                  // unavailable with unmark) and the auto-split logic
                  // against `demand`. Per-vendor view now lives up to its
                  // original purpose: standing at stall X, see everything
                  // I'm buying here, type prices in one go.
                  const runItem = itemBySku.get(r.skuId);
                  if (!runItem) {
                    // Defensive — the bucket was derived from run.items;
                    // if lookup fails, render a read-only stub instead
                    // of crashing.
                    return (
                      <li
                        key={r.skuId}
                        className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-body">{skuName}</span>
                        <span className="shrink-0 font-mono text-body tabular-nums text-[var(--c-fg-muted)]">
                          {formatQty(r.plannedQty)} {unitLabel(r.sku?.unit)}
                        </span>
                      </li>
                    );
                  }
                  // M3.52: same as the aggregate view — pass the
                  // per-SKU recorded splits so PurchaseRow can render
                  // the per-store chips. Critical here because the
                  // per-vendor view is where the purchaser actually
                  // stands at the stall counting items into bags;
                  // they need the per-store qty in front of them.
                  const actualSplits = (splitsBySku.get(r.skuId) ?? []).map((sp) => ({
                    storeId: sp.storeId,
                    qty: sp.qty,
                    unitPrice: sp.unitPrice,
                    paymentMethod: sp.paymentMethod,
                  }));
                  return (
                    <PurchaseRow
                      key={r.skuId}
                      item={runItem}
                      skuName={skuName}
                      unit={unitLabel(r.sku?.unit)}
                      step={r.sku?.step ?? '0.1'}
                      demand={demandBySku.get(r.skuId) ?? []}
                      storeById={storeById}
                      actualSplits={actualSplits}
                      isMultiStoreRun={isMultiStoreRun}
                      lastPrice={run.lastPriceBySku?.[r.skuId] ?? null}
                      lastPriceObservedAt={run.lastPriceObservedAtBySku?.[r.skuId] ?? null}
                      i18n={i18n}
                      priceInThousands={priceInThousands}
                      onTogglePriceUnit={onTogglePriceUnit}
                      saving={savingSkuId === r.skuId}
                      // The one place in the app that knows WHERE a
                      // purchase happened: the purchaser is working
                      // this stall's bucket. Everything else sends
                      // null — see the handler in RunPage.
                      onSave={(p) => onSavePurchaseInline({ ...p, supplierId: b.supplierId })}
                      onMarkNa={onMarkNa}
                      onEdit={onEditPurchased}
                      onUnmark={onUnmark}
                      onOpenAdvanced={onOpenAdvancedPurchase}
                      onSetPaymentMethod={onSetPaymentMethod}
                      paymentBusy={paymentBusySkuId === r.skuId}
                    />
                  );
                })}
            </ul>
          </Card>
        );
      })}
      {/* M3.31 (2026-05-18, A.1): extras footer. "其他物品" rows don't
          carry a supplier link, so they naturally fall outside the
          per-vendor buckets above. Render them in one card at the
          bottom, grouped by store so the purchaser knows which store
          asked for each one-off pickup. Without this section the
          per-vendor view was structurally hiding all extras even
          though run.get already ships them. */}
      <RunExtrasCard
        sessionExtrasByStore={run.sessionExtrasByStore}
        sessionNotesByStore={run.sessionNotesByStore}
        storeById={storeById}
        i18n={i18n}
        // 2026-07-06: match the per-store path — editable during
        // purchasing AND super-admin amending (was purchasing-only,
        // making extras editability view-mode-dependent).
        editable={run.status === 'purchasing' || run.status === 'amending'}
        onMarkExtraStatus={onMarkExtraStatus}
        onRecordExtraExpense={onRecordExtraExpense}
      />
    </div>
  );
}

/**
 * Shared "其他物品" footer card used by the active-run by-vendor view
 * and (in M3.31) the aggregate edit list. Renders each store's
 * structured extras + legacy free-text note inside a single yellow-
 * tinted block. Returns null when there are no extras and no notes
 * anywhere — keeps the perVendor/aggregate trailing margin clean.
 */
export function RunExtrasCard({
  sessionExtrasByStore,
  sessionNotesByStore,
  storeById,
  i18n,
  editable = false,
  onMarkExtraStatus,
  onRecordExtraExpense,
}: {
  sessionExtrasByStore?: Record<
    string,
    Array<{
      name: string;
      qty: string;
      unit: string;
      note?: string;
      status?: 'pending' | 'bought' | 'unavailable';
      sessionId?: string;
      idx?: number;
    }>
  >;
  sessionNotesByStore?: Record<string, string>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  i18n: ReturnType<typeof useI18n>;
  /** M3.37 (Wave2 #5): when true, tap a row to cycle pending → bought
   *  → unavailable → pending. Only true during run.status='purchasing'. */
  editable?: boolean;
  onMarkExtraStatus?: (
    sessionId: string,
    extraIndex: number,
    status: 'pending' | 'bought' | 'unavailable',
  ) => void;
  onRecordExtraExpense?: (
    storeId: string,
    extra: { name: string; qty: string; unit: string; note?: string },
  ) => void;
}) {
  // See PerStoreView — raw unit codes leaked here too.
  const unitLabel = useUnitLabel();
  const resolveStoreName = (id: string) => storeById.get(id)?.name ?? id.slice(0, 8);
  const storeIds = [
    ...new Set([
      ...Object.keys(sessionExtrasByStore ?? {}),
      ...Object.keys(sessionNotesByStore ?? {}),
    ]),
  ].filter((id) => {
    const extras = sessionExtrasByStore?.[id] ?? [];
    const note = (sessionNotesByStore?.[id] ?? '').trim();
    return extras.length > 0 || note.length > 0;
  });
  if (storeIds.length === 0) return null;
  // M3.37: small lookup for the visual + accessible label per status.
  const statusVisual = (
    status: 'pending' | 'bought' | 'unavailable',
  ): { mark: string; tone: string; label: string } => {
    switch (status) {
      case 'bought':
        return {
          mark: '✓',
          tone: 'text-[var(--c-success)]',
          label: i18n.t('run.extras.status.bought'),
        };
      case 'unavailable':
        return {
          mark: '✗',
          tone: 'text-[var(--c-danger)]',
          label: i18n.t('run.extras.status.unavailable'),
        };
      default:
        return {
          mark: '·',
          tone: 'text-[var(--c-fg-muted)]',
          label: i18n.t('run.extras.status.pending'),
        };
    }
  };
  const cycle = (
    s: 'pending' | 'bought' | 'unavailable',
  ): 'pending' | 'bought' | 'unavailable' =>
    s === 'pending' ? 'bought' : s === 'bought' ? 'unavailable' : 'pending';

  return (
    <Card>
      <SectionLabel meta="">{i18n.t('order.extras.label')}</SectionLabel>
      <div className="flex flex-col gap-3 px-4 pb-3">
        {storeIds.map((storeId) => {
          const extras = sessionExtrasByStore?.[storeId] ?? [];
          const note = (sessionNotesByStore?.[storeId] ?? '').trim();
          return (
            <div key={storeId}>
              <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                {resolveStoreName(storeId)}
              </div>
              {extras.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {extras.map((e, idx) => {
                    const status = e.status ?? 'pending';
                    const v = statusVisual(status);
                    const hasAddress =
                      typeof e.sessionId === 'string' && typeof e.idx === 'number';
                    const canTap = editable && !!onMarkExtraStatus && hasAddress;
                    const canRecordExpense = editable && !!onRecordExtraExpense;
                    const inner = (
                      <>
                        <span aria-hidden className={`shrink-0 text-body ${v.tone}`}>
                          {v.mark}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">
                          {e.name}
                          {e.note ? (
                            <span className="ml-1 text-[var(--c-fg-muted)]">
                              · {e.note}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                          {e.qty} {unitLabel(e.unit)}
                        </span>
                      </>
                    );
                    return (
                      <li
                        key={`${e.sessionId ?? storeId}-${e.idx ?? idx}-${e.name}`}
                        className="text-body-sm"
                      >
                        <div className="-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-1 rounded-[var(--r-utility)] px-2 py-0.5">
                          {canTap ? (
                            <button
                              type="button"
                              title={i18n.t('run.extras.status.cycleHint', { current: v.label })}
                              onClick={() =>
                                onMarkExtraStatus!(e.sessionId!, e.idx!, cycle(status))
                              }
                              className="flex min-w-0 flex-1 items-baseline gap-2 rounded-[var(--r-utility)] text-left active:bg-[var(--c-surface-2)]"
                            >
                              {inner}
                            </button>
                          ) : (
                            <div className="flex min-w-0 flex-1 items-baseline gap-2">
                              {inner}
                            </div>
                          )}
                          {canRecordExpense ? (
                            <button
                              type="button"
                              onClick={() => onRecordExtraExpense!(storeId, e)}
                              className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-capsule)] px-2 py-0.5 text-label font-medium text-[var(--c-action)] active:opacity-70"
                            >
                              {i18n.t('run.extras.recordPrice')}
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {note ? (
                <div className="mt-1 whitespace-pre-wrap text-body-sm italic leading-snug text-[var(--c-fg-muted)]">
                  {note}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * M3.44 (2026-05-22): off-catalog expenses card. Renders below the SKU
 * items list (in aggregate / perVendor view) so the purchaser sees
 * EVERYTHING they bought / spent against this run in one continuous
 * scroll. Each row carries a delete (✗) affordance so a typo'd
 * expense can be retracted before finish — the server emits a
 * RunExpenseRemoved event and the read-model row is soft-deleted
 * (admin reports can still see the add → remove timeline).
 *
 * Display per row:
 *   {label} · {qty} {unitHint} × {unitPrice} = {total} · 💵/🏦 · [✗ del?]
 *
 * The card's section header summarizes total expense count + sum so
 * the manager glancing at the run page has the off-plan number front
 * and center, no need to hunt through individual rows.
 */
export function ExpensesCard({
  expenses,
  storeById,
  i18n,
  priceInThousands,
  editable,
  onRemove,
  onOpenExpense,
}: {
  expenses: ActiveRun['expenses'];
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  i18n: ReturnType<typeof useI18n>;
  priceInThousands: boolean;
  /** When true (status='purchasing' + claim is mine), show the ✗ delete
   *  button on each row. Read-only otherwise. */
  editable: boolean;
  onRemove: (expenseId: string, label: string) => void;
  onOpenExpense: () => void;
}) {
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const list = expenses ?? [];
  const grandTotal = list.reduce(
    (s, e) => s + Number(e.qty) * Number(e.unitPrice),
    0,
  );
  return (
    <Card>
      <SectionLabel meta={`${list.length} · ${formatMoney(grandTotal)} ${currency}`}>
        {i18n.t('run.section.expenses')}
      </SectionLabel>
      {editable ? (
        <div className="flex justify-end px-4 pb-2">
          <button
            type="button"
            onClick={onOpenExpense}
            className="inline-flex h-[var(--capsule-h)] shrink-0 items-center whitespace-nowrap rounded-[var(--r-pill)] bg-[var(--c-action)] px-3 text-body-sm font-medium text-[var(--c-action-fg)] active:opacity-70"
          >
            {i18n.t('run.action.addExpense.button')}
          </button>
        </div>
      ) : null}
      {list.length === 0 ? (
        <div className="px-4 pb-3 text-body-sm text-[var(--c-fg-muted)]">
          {i18n.t('run.action.addExpense.scopeSharedHint')}
        </div>
      ) : null}
      <ul className="flex flex-col" role="list">
        {list.map((e) => {
          const total = Number(e.qty) * Number(e.unitPrice);
          const isTransfer = e.paymentMethod === 'transfer';
          // Show the store names this expense was allocated to,
          // helpful for the "shared porter" / "split between 3 stores"
          // narrative. Falls back to short id slice if a store row
          // was archived after the expense landed.
          const storeNames = e.storeSplits
            .map((sp) => storeById.get(sp.storeId)?.name ?? sp.storeId.slice(0, 8))
            .join(' · ');
          const unitPriceDisplay = priceInThousands
            ? `${formatMoney(Number(e.unitPrice) / 1000)}K`
            : formatMoney(e.unitPrice);
          return (
            <li
              key={e.id}
              className="border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
            >
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 truncate text-body font-semibold">
                  {e.label}
                </span>
                <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-capsule)] px-1.5 py-0.5 text-label text-[var(--c-fg-muted)]">
                  {i18n.t(
                    e.storeSplits.length > 1
                      ? 'run.section.sharedExpenses'
                      : 'run.section.storeExpenses',
                  )}
                </span>
                {isTransfer ? (
                  <span
                    aria-label={i18n.t('run.label.paymentTransfer')}
                    title={i18n.t('run.label.paymentTransfer')}
                    className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-info-bg)] px-1.5 py-0.5 text-label text-[var(--c-action)]"
                  >
                    {i18n.t('run.label.paymentTransfer')}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
                  {storeNames}
                </span>
                {editable ? (
                  <button
                    type="button"
                    onClick={() => onRemove(e.id, e.label)}
                    aria-label={i18n.t('run.action.removeExpense')}
                    className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-capsule)] px-2 py-0.5 text-label text-[var(--c-danger)] active:bg-[var(--c-surface-2)]"
                  >
                    ✗
                  </button>
                ) : null}
              </div>
              <div className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                <span className="font-mono tabular-nums">
                  {formatQty(e.qty)} {e.unitHint ?? ''} × {unitPriceDisplay}
                </span>
                {' = '}
                <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">
                  {formatMoney(total)} {currency}
                </span>
                {e.reason ? (
                  <>
                    {' · '}
                    <span className="italic">{e.reason}</span>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function PerCategoryView({
  run,
  skuById,
  categoryById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  onTogglePriceUnit,
  savingSkuId,
  demandBySku,
  onSavePurchaseInline,
  onMarkNa,
  onOpenAdvancedPurchase,
  onEditPurchased,
  onUnmark,
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
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  savingSkuId: string | null;
  demandBySku: Map<string, Array<{ storeId: string; qty: string }>>;
  onSavePurchaseInline: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    /**
     * Where the purchase actually happened. Only the by-stall view can
     * know this (the purchaser is working one stall at a time), so the
     * other views omit it and the handler falls back to null rather
     * than guessing from the SKU's preferred supplier.
     */
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
  onSetPaymentMethod: (
    item: ActiveRun['items'][number],
    next: 'cash' | 'transfer',
  ) => void;
  paymentBusySkuId: string | null;
}) {
  // See PerStoreView — raw unit codes leaked here too.
  const unitLabel = useUnitLabel();
  const demandStoreIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of run.perStoreDemand ?? []) ids.add(d.storeId);
    if (ids.size === 0) for (const sp of run.splits) ids.add(sp.storeId);
    return [...ids];
  }, [run.perStoreDemand, run.splits]);
  // Indexed once — see PerVendorView.
  const splitsBySku = useMemo(() => {
    const m = new Map<string, typeof run.splits>();
    for (const sp of run.splits) {
      const arr = m.get(sp.skuId) ?? [];
      arr.push(sp);
      m.set(sp.skuId, arr);
    }
    return m;
  }, [run.splits]);
  const groups = useMemo(() => {
    const byCategory = new Map<string, ActiveRun['items']>();
    for (const item of run.items) {
      const sku = skuById.get(item.skuId);
      const categoryId = sku?.categoryId ?? '__uncategorized__';
      const arr = byCategory.get(categoryId) ?? [];
      arr.push(item);
      byCategory.set(categoryId, arr);
    }
    return [...byCategory.entries()]
      .map(([categoryId, items]) => ({
        categoryId,
        name:
          categoryId === '__uncategorized__'
            ? // 2026-07-26: was a hard-coded Chinese literal.
              i18n.t('run.view.uncategorized')
            : productName(categoryById.get(categoryId) ?? { names: { zh: categoryId.slice(0, 8) } }),
        items,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categoryById, i18n, productName, run.items, skuById]);

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const totalQty = group.items.reduce((s, it) => s + Number(it.plannedQty || 0), 0);
        return (
        <details
          key={group.categoryId}
          open
          className="overflow-hidden rounded-[var(--r-card)] bg-[var(--c-surface)] ring-hairline"
        >
          {/* Unified (2026-07-05): the category header now renders the
              same GroupCardHeader as the per-store / per-vendor views
              (was px-4 py-2 with the count inlined after the name — a
              third chrome for the same semantic element). The <summary>
              wrapper keeps the native collapse affordance. */}
          <summary className="cursor-pointer list-none">
            <GroupCardHeader
              title={group.name}
              meta={i18n.t('run.label.skuCountAndQty', {
                n: group.items.length,
                qty: formatQty(String(totalQty)),
              })}
            />
          </summary>
          <ul className="flex flex-col" role="list">
            {group.items.map((item) => {
              const sku = skuById.get(item.skuId);
              const skuName = sku ? productName(sku) : item.skuId.slice(0, 8);
              const actualSplits = (splitsBySku.get(item.skuId) ?? []).map((sp) => ({
                storeId: sp.storeId,
                qty: sp.qty,
                unitPrice: sp.unitPrice,
                paymentMethod: sp.paymentMethod,
              }));
              return (
                <PurchaseRow
                  key={item.skuId}
                  item={item}
                  skuName={skuName}
                  unit={unitLabel(sku?.unit)}
                  step={sku?.step ?? '0.1'}
                  demand={demandBySku.get(item.skuId) ?? []}
                  storeById={storeById}
                  actualSplits={actualSplits}
                  isMultiStoreRun={demandStoreIds.length > 1}
                  lastPrice={run.lastPriceBySku?.[item.skuId] ?? null}
                  lastPriceObservedAt={run.lastPriceObservedAtBySku?.[item.skuId] ?? null}
                  i18n={i18n}
                  priceInThousands={priceInThousands}
                  onTogglePriceUnit={onTogglePriceUnit}
                  saving={savingSkuId === item.skuId}
                  onSave={onSavePurchaseInline}
                  onMarkNa={onMarkNa}
                  onEdit={onEditPurchased}
                  onUnmark={onUnmark}
                  onOpenAdvanced={onOpenAdvancedPurchase}
                  onSetPaymentMethod={onSetPaymentMethod}
                  paymentBusy={paymentBusySkuId === item.skuId}
                />
              );
            })}
          </ul>
        </details>
        );
      })}
    </div>
  );
}

/* ── Row geometry. ONE track set, ALL FOUR states. ───────────────────
 *
 * The width is measured, not assumed. RunPage.tsx:1596 wraps the whole
 * list in `px-4` and the <li> adds its own, so a 375px viewport leaves
 * 311px of row — not the 343 you get by counting one of them:
 *
 *   375 viewport
 *   −32  RunPage px-4   → 343  card
 *   −32  <li> px-4      → 311  row
 *   −36  control (h-11 w-9)
 *   − 6  gap-1.5        → 269  tap target
 *
 *    20  state cell   fixed, never text, so it cannot grow with locale
 *     ?  name         minmax(0,1fr) — the ONLY thing that may truncate
 *    48  qty  floor
 *    68  money floor
 *    18  3 × 6px gap
 *   ───
 *   269 − 154 = 115px of name
 *
 * Numbers get a FLOOR, not a fixed width, so an outlier grows its own
 * track and pays for it out of the NAME. That is the rule already
 * written down at RunPanels.tsx — "only the product name and the stall
 * name may truncate; every number is shrink-0, because a half-visible
 * price is worse than a wrapped one" — which the preview rows follow
 * and these rows did the exact opposite of: every name was `shrink-0
 * truncate` (so `truncate` was dead CSS), leaving the meta span holding
 * qty AND price as the only compressible thing on the row. A long name
 * deleted both numbers and then overflowed the button.
 *
 * Money floor is honest about the worst case: '1,250,000' is 10 glyphs,
 * ui-monospace advances 0.6em, so at text-label (11px) that is 66px and
 * fits in 68. No money string is ever clipped.
 */
const ROW_TRACKS = '1.25rem minmax(0,1fr) minmax(3rem,auto) minmax(4.25rem,auto)';

/* 52px, NOT 44. The control is h-11; two 44px controls in a 45px row sit
 * 1px apart, and an off-by-one-row thumb on this list commits money
 * against the wrong SKU with no confirmation step. 52 keeps ~9px of dead
 * space between adjacent commit targets (today's row: 13px). Density is
 * not what this redesign buys — see the note on the PurchaseRow doc. */
const ROW_SHELL = 'flex min-h-[3.25rem] items-center gap-1.5 px-4';

const ROW_TAP =
  'press grid min-w-0 flex-1 items-center gap-x-1.5 rounded-[var(--r-utility)] ' +
  'text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--c-ring)]';
const ROW_STATIC = 'grid min-w-0 flex-1 items-center gap-x-1.5';

/* 36 wide × 44 tall (--control-h-touch, the ladder's restricted `touch`
 * tier). The thumb travels VERTICALLY on a scrolling list, so 44 is
 * required in that dimension only; every pixel of width comes straight
 * out of the number the purchaser reads back to a vendor. This is the
 * reasoning already recorded for the existing ✓ button. */
const ROW_CTRL =
  'flex h-[var(--control-h-touch)] w-9 shrink-0 items-center justify-center self-center ' +
  'rounded-[var(--r-pill)] text-body outline-none ' +
  'focus-visible:ring-1 focus-visible:ring-[var(--c-ring)]';

/* Measured, not eyeballed. --c-action-fg on --c-action is 4.60:1 and
 * passes AA. The audit asked for this disc to be demoted to a pale tint
 * + ring, but --c-action on --c-info-bg is 3.97:1 light and 3.15:1 dark
 * — LESS legible than what ships, on a screen whose first constraint is
 * direct sunlight. The audit is right that 87 saturated discs are loud;
 * it is wrong about which element should give way. The row gets quiet by
 * losing the mark-unavailable pill and the run of orange text, not by
 * dimming the one control that commits money. */
const CTRL_COMMIT =
  'bg-[var(--c-action)] font-semibold text-[var(--c-action-fg)] active:opacity-80';
const CTRL_OFF = 'bg-[var(--c-capsule)] font-semibold text-[var(--c-fg-muted)]';
const CTRL_QUIET = 'bg-[var(--c-capsule)] text-[var(--c-fg-muted)] active:opacity-70';
const CTRL_TRANSFER = 'bg-[var(--c-info-bg)] text-[var(--c-action)] active:opacity-70';

/* px-4 (16) + state cell (20) + gap (6) — lines a second line up with
 * the name's left edge. */
const SUBLINE = 'pb-1.5 pl-[2.625rem] pr-4';

type RowStateKind = 'pending' | 'unpriced' | 'saving' | 'purchased' | 'unavailable';

/**
 * The row's status mark.
 *
 * It is the sole carrier of row state and was `aria-hidden` in three of
 * the four states, so a screen-reader user could not tell a bought row
 * from an outstanding one. Every glyph here is still `aria-hidden` —
 * "✓" read aloud is noise — but each is paired with an sr-only twin.
 *
 * Every state also has a distinct SHAPE (hollow ring / ! / filled dot /
 * ✓ / ✗) rather than only a distinct colour, so the row survives
 * greyscale, sunlight and a colour-blind purchaser.
 *
 * The cell is 20px wide in all four states, which is what stops the
 * name's left edge from jittering: pending names used to start at x=16
 * and purchased ones at x≈37, so a mixed list had a ragged left edge.
 */
function RowStateCell({ kind, label }: { kind: RowStateKind; label: string }) {
  return (
    <span className="flex items-center justify-center">
      <span aria-hidden className="flex items-center justify-center leading-none">
        {kind === 'pending' ? (
          <span className="block h-[7px] w-[7px] rounded-[var(--r-pill)] ring-1 ring-[var(--c-fg-muted)]" />
        ) : kind === 'saving' ? (
          <span className="block h-[7px] w-[7px] animate-pulse rounded-[var(--r-pill)] bg-[var(--c-action)] motion-reduce:animate-none" />
        ) : kind === 'unpriced' ? (
          <span className="block text-body font-semibold text-[var(--c-warning-fg)]">!</span>
        ) : kind === 'purchased' ? (
          <span className="block text-body text-[var(--c-success)]">✓</span>
        ) : (
          <span className="block text-body text-[var(--c-danger)]">✗</span>
        )}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * One row of the purchasing list. Holds its OWN qty/price input state
 * (not in the parent) so typing one row doesn't re-render the whole list.
 *
 * Auto-save logic: fires `onSave` when (a) the row is `pending`, (b) qty
 * matches the per-store demand we know about (so we can derive splits
 * automatically), (c) price > 0. If qty differs from planned and the run
 * has multiple stores, we don't try to guess the new split — instead we
 * surface a "more options" link that opens the full PurchaseSheet, where
 * the user manually allocates.
 *
 * Save fires on price-input BLUR (Telegram numeric keyboard's "Done"
 * button blurs the input — natural commit point). We don't save on every
 * keystroke; that would race the network on slow links.
 */
export function PurchaseRow({
  item,
  skuName,
  unit,
  step,
  demand,
  storeById,
  actualSplits,
  isMultiStoreRun,
  lastPrice,
  lastPriceObservedAt,
  i18n,
  priceInThousands,
  onTogglePriceUnit,
  saving,
  onSave,
  onMarkNa,
  onEdit,
  onUnmark,
  onOpenAdvanced,
  onSetPaymentMethod,
  paymentBusy,
}: {
  item: ActiveRun['items'][number];
  skuName: string;
  unit: string;
  step: string;
  demand: Array<{ storeId: string; qty: string }>;
  /**
   * M3.52 (2026-05-23): resolves storeId → store name for the per-store
   * breakdown line shown under the SKU title. Without this the
   * purchaser at the stall couldn't see how to bag the bought items
   * across multiple stores ("店A 2kg · 店B 3kg") — they only saw
   * the aggregate qty.
   */
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  /**
   * M3.52: post-purchase per-store actual allocation (from
   * run.splits filtered to this skuId). For pending rows it's empty
   * and we fall back to `demand` (the planned breakdown). For
   * purchased rows it shows what was actually allocated — usually
   * matches the proportional split of `demand` * actualQty/plannedQty
   * but the advanced sheet can override.
   */
  actualSplits: Array<{
    storeId: string;
    qty: string;
    unitPrice?: string | null;
    paymentMethod?: string | null;
  }>;
  /**
   * M3.52 (2026-05-23 fix): true when the run spans ≥2 stores. We
   * show the per-store chip on EVERY row of a multi-store run, even
   * when that row's demand is only from a single store. Without this,
   * rows where only Store-A wants the SKU stayed unlabeled and the
   * purchaser couldn't tell — at the stall — that this item is just
   * for Store-A (and not, say, for Store-B which is the other half of
   * the run). The chip line is suppressed only for single-store runs
   * where the aggregate qty already tells the whole story.
   */
  isMultiStoreRun: boolean;
  lastPrice: string | null;
  /** When that reference price was observed, ISO. Drives the stale mark. */
  lastPriceObservedAt?: string | null;
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, the price input shows raw UZS / 1000. Save still
   *  emits raw UZS. */
  priceInThousands: boolean;
  /**
   * Flip the price field between UZS and thousands-of-UZS (2026-07-30).
   *
   * The control used to be a `×千` pill in the sticky bar whose meaning
   * lived ONLY in a `title` attribute — invisible on touch, where there is
   * no hover. It defaulted to ON and silently multiplied every price the
   * purchaser typed by 1000. Moving it onto the unit suffix beside the
   * price input puts it where the user is already looking when the setting
   * matters, and lets the suffix state the current unit instead of naming
   * an operation.
   */
  onTogglePriceUnit: () => void;
  saving: boolean;
  onSave: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    storeSplits: Array<{
      storeId: string;
      qty: string;
      unitPrice?: string;
      paymentMethod?: 'cash' | 'transfer';
    }>;
    paymentMethod: 'cash' | 'transfer';
  }) => void;
  onMarkNa: (skuId: string) => void;
  onEdit: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  onOpenAdvanced: (item: ActiveRun['items'][number]) => void;
  /**
   * Correct the payment method of an ALREADY purchased row, from the row
   * itself.
   *
   * The one-tap ✓ path has no method control, and `paymentMethod`
   * defaults to 'cash' — so since the collapsed row became the default
   * for every priced item, the fast path has been booking everything as
   * cash and `totalCash` / `totalTransfer` drift by construction.
   *
   * This deliberately does NOT go through `onSave`. That reaches
   * `PurchaseItem`, which has no already-purchased guard and emits a
   * fresh `ItemPurchased`; the projection then appends an undeduped
   * `price_history` row per tap and upserts `run_item_stores_v` with
   * `unitPrice: split.unitPrice ?? null`, silently erasing per-store
   * price overrides. The caller routes this through `revisePurchase`.
   */
  onSetPaymentMethod: (
    item: ActiveRun['items'][number],
    next: 'cash' | 'transfer',
  ) => void;
  paymentBusy: boolean;
}) {
  // Default qty = planned. Price defaults to the last observed market
  // price for this SKU — saves typing when prices are unchanged from
  // the previous run, which is the common case for staple goods. User
  // can overwrite.
  //
  // toQtyInput, NOT formatQty: this value is editable and handleSave
  // sends it to the API verbatim. formatQty rounds to one decimal and
  // adds thousand separators, which turned a planned 1.25 kg into a
  // saved 1.3 kg and made every qty >= 1000 unsaveable. See the doc
  // comment on toQtyInput.
  const [qty, setQty] = useState<string>(
    toQtyInput(item.purchasedQty ?? item.plannedQty),
  );
  // M3.36: `price` holds the DISPLAYED value (divided by 1000 when in
  // thousands mode). Stays as the user typed it through intermediate
  // states like "147." — the raw conversion only happens at save.
  const [price, setPrice] = useState<string>(
    toDisplayPrice(item.unitPrice ?? lastPrice ?? '', priceInThousands),
  );
  // M1.14: per-item payment method. Default cash (the common case at
  // the market). User taps the chip to flip cash ↔ transfer before
  // pressing ✓. Edit-existing uses the persisted value.
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'transfer'>(
    (item.paymentMethod as 'cash' | 'transfer') ?? 'cash',
  );
  // M1.21: pull the org-wide currency from session so the inline
  // suffix shows RUB / KZT / USD for non-UZS tenants. Hardcoded "UZS"
  // pre-M1.21; harmless on the UZS launch tenant but blocked multi-
  // tenant rollout.
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';

  /**
   * Q7(b): the qty/price editor is closed until the purchaser asks for
   * it. Local to the row and not persisted — reopening the page should
   * present the compact list again, and a row the user opened but did
   * not save has nothing worth restoring.
   */
  const [priceEditorOpen, setPriceEditorOpen] = useState(false);

  // When server data updates (ws push, an edit landing, an undo),
  // reconcile the local input values.
  //
  // The guard used to be `item.status === 'pending'`, meant as "don't
  // clobber what the user is typing". Since Q7(b) that is the wrong
  // question: a pending row is COLLAPSED by default and has no inputs
  // to protect, while purchased → revised → undone lands back on
  // pending and so never resynced — leaving local state holding the
  // revised figures behind a row printing the reference again.
  //
  // The real question is whether the editor is open, which is the only
  // time a keystroke exists to lose.
  useEffect(() => {
    if (priceEditorOpen) return;
    setQty(toQtyInput(item.purchasedQty ?? item.plannedQty));
    setPrice(toDisplayPrice(item.unitPrice ?? lastPrice ?? '', priceInThousands));
  }, [
    priceEditorOpen,
    item.status,
    item.purchasedQty,
    item.unitPrice,
    item.plannedQty,
    lastPrice,
    priceInThousands,
  ]);

  // A row that leaves `pending` (saved, or marked unavailable) has
  // nothing left to edit, so the editor closes — which also re-arms the
  // reconcile effect above for the next time it comes back.
  useEffect(() => {
    if (item.status !== 'pending') setPriceEditorOpen(false);
  }, [item.status]);

  // M3.36: when the page-level toggle flips while a row is mid-edit
  // (pending), rescale the displayed price so the same underlying
  // UZS value rides through the mode change. Without this, flipping
  // mid-typing would silently mis-scale the next save (e.g. user
  // typed 147500 in raw mode, toggles K mode → handleSave would
  // re-multiply ×1000 → 147,500,000).
  const prevThousandsRef = useRef(priceInThousands);
  /** Enter on qty jumps here; Enter here saves. See the input grid below. */
  const priceRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (prevThousandsRef.current === priceInThousands) return;
    setPrice((p) => {
      if (!p) return p;
      const n = Number(p);
      if (!Number.isFinite(n)) return p;
      return priceInThousands ? String(n / 1000) : String(n * 1000);
    });
    prevThousandsRef.current = priceInThousands;
  }, [priceInThousands]);

  /**
   * Mis-tap protection: previously this fired automatically on input
   * blur, which the user reported as risky in chaotic market
   * conditions. Now it only fires when the explicit ✓ Save button
   * is tapped. After save, the row flips to read-only "purchased"
   * state — no more accidental edits.
   *
   * Returns true on success so the caller can update local "saved"
   * state before the server roundtrip lands.
   */
  /**
   * Inline save with proportional auto-split.
   *
   * Workflow the user described:
   *   "如果同一种物品多店铺都要购买,而出于各种原因购买数量重量与店铺
   *    申请的不一样,这个需要能在写价格的时候就能更改。我们只需要写
   *    单价,根据具体的总价来自动计算"
   *
   * So: user enters whatever actual qty they got, we scale the
   * per-store demand to match. E.g. 3 stores planned 1+1.5+0.5kg
   * (total 3kg), bought only 2kg → splits become 0.67+1.0+0.33kg.
   *
   * Float drift: scaled portions can sum to actualQty ± a tiny
   * rounding error. The domain validates `Math.abs(sum-actual) < 1e-6`.
   * Workaround: assign exact-rounded values to every store except the
   * last, and have the last store absorb whatever's left so the total
   * matches actualQty bit-perfectly.
   */
  const computeProportionalSplits = (actualQtyStr: string) =>
    proportionalSplitQty(demand, actualQtyStr);

  /**
   * Can the COLLAPSED row's one-tap ✓ commit?
   *
   * Asks about the values the collapsed row actually prints, not the
   * ones in this component's inputs. Without this the ✓ armed itself
   * from stale local state: a row with no reference price at all
   * rendered "?" in the money column and a fully blue, enabled ✓,
   * because `price` still held a figure from a purchase that had since
   * been undone.
   */
  const collapsedPayload = collapsedCommit({
    status: item.status,
    saving,
    plannedQty: item.plannedQty,
    lastPrice,
  });
  const canSaveCollapsed = collapsedPayload !== null;

  /**
   * @param source
   *   'editor'    — commit what is in the inputs.
   *   'collapsed' — commit what the COLLAPSED ROW PRINTS, taken from
   *                 props rather than from this component's state.
   *
   * The distinction is not cosmetic. `qty` and `price` are local state
   * seeded once at mount, and the reconcile effect deliberately skips
   * while the row is pending — so a row that went pending → purchased →
   * revised → undone keeps the REVISED figures in local state while the
   * collapsed row prints `lastPrice` and `item.plannedQty` again. The
   * one-tap ✓ then committed numbers that appeared nowhere on screen:
   * displayed 70,000 x 10 kg, saved 999,000 x 7. Reading the props back
   * makes "the ✓ commits exactly what the row shows" true by
   * construction instead of by an effect firing in the right order.
   */
  const handleSave = (source: 'editor' | 'collapsed' = 'editor') => {
    if (item.status !== 'pending') return;
    if (saving) return;
    const actualQty = source === 'collapsed' ? (collapsedPayload?.qty ?? '') : qty.trim();
    const displayPrice =
      source === 'collapsed'
        ? toDisplayPrice(collapsedPayload?.price ?? '', priceInThousands).trim()
        : price.trim();
    if (!actualQty || Number(actualQty) <= 0) return;
    if (!displayPrice || Number(displayPrice) <= 0) return;

    const splits = computeProportionalSplits(actualQty);
    if (!splits || splits.length === 0) {
      // No demand info available (legacy run pre-perStoreDemand).
      // Fall back to opening the full sheet.
      onOpenAdvanced(item);
      return;
    }
    onSave({
      skuId: item.skuId,
      actualQty,
      // M3.36: convert display → raw UZS at the network boundary.
      unitPrice: fromDisplayPrice(displayPrice, priceInThousands),
      // The collapsed row has no payment control, so it must not carry
      // a method this component happens to be holding — 'cash' is the
      // documented default for a one-tap buy, and the purchased row's
      // toggle is how a transfer gets recorded.
      paymentMethod: source === 'collapsed' ? 'cash' : paymentMethod,
      storeSplits: splits,
    });
  };

  // Live "total = qty × price" hint shown below the inputs. Helps the
  // user sanity-check before tapping Save. M3.36: in thousands mode the
  // displayed `price` is divided by 1000, so multiply back so the
  // total reflects the actual UZS the operator will pay.
  const totalHint = useMemo(() => {
    const q = Number(qty);
    const p = Number(price);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) {
      return null;
    }
    const effectiveP = priceInThousands ? p * 1000 : p;
    return Math.round(q * effectiveP);
  }, [qty, price, priceInThousands]);

  const canSave =
    item.status === 'pending' &&
    !saving &&
    Number(qty) > 0 &&
    Number(price) > 0;


  /**
   * M3.52 (2026-05-23): per-store demand breakdown chip row.
   *
   * The pain point — user-reported in two passes:
   *
   *   Pass 1: "When a run has ≥2 stores, a row with demand from
   *   multiple stores collapsed into one aggregate qty (e.g. '5kg
   *   apples'). At the stall the purchaser couldn't tell that this
   *   is 'store-A 2kg + store-B 3kg'."
   *
   *   Pass 2 (this revision): "Multi-store rows are now labeled, but
   *   the rows where ONLY ONE store wants the SKU aren't labeled
   *   either — those still look ambiguous." Correct: in a multi-
   *   store run, a single-store-demand row of "5kg apples" tells
   *   the purchaser nothing about which store it belongs to.
   *
   * Fix: render a row of compact chips ([店A 2 kg] / [店A 2 kg] [店B 3 kg])
   * right under the SKU title for EVERY row of a multi-store run,
   * whether the demand spans one or many stores. Suppress only when
   * the entire run is single-store (the run-level "which store?" is
   * obvious without the chips).
   *
   * Source of truth:
   *   - pending  → `demand` (run.perStoreDemand for this skuId)
   *   - purchased → `actualSplits` (run.splits filtered to this
   *     skuId, post-allocation; usually mirrors demand × actualQty/
   *     plannedQty but the advanced sheet can override per-store).
   *   - unavailable → omitted (no actual buy + the unavailability
   *     applies to all stores uniformly; chips would imply otherwise).
   */
  const breakdown = item.status === 'pending' ? demand : actualSplits;
  const showBreakdown = isMultiStoreRun && breakdown.length >= 1;
  /**
   * On a SINGLE-store row the chip's quantity is the same number the row
   * already prints in its quantity column — by construction, since
   * plannedQty (and purchasedQty) for a one-store row IS that store's
   * figure. 78% of production rows are single-store (3,137 of 4,024), so
   * that duplicate was on most of the list.
   *
   * The store NAME stays: it is what M3.52's second pass explicitly
   * asked for ("the rows where ONLY ONE store wants the SKU aren't
   * labeled either — those still look ambiguous"). Only the redundant
   * figure goes. Multi-store rows are unchanged — there the per-store
   * quantities are the whole point, because they say how much to put in
   * each bag.
   */
  const singleStore = breakdown.length === 1;
  const breakdownChips = showBreakdown ? (
    <div className="flex flex-wrap items-center gap-1.5">
      {breakdown.map((d) => {
        const storeName =
          storeById.get(d.storeId)?.name ?? d.storeId.slice(0, 8);
        const splitMeta = d as { unitPrice?: string | null; paymentMethod?: string | null };
        const overridePrice =
          splitMeta.unitPrice && splitMeta.unitPrice !== item.unitPrice
            ? toDisplayPrice(splitMeta.unitPrice, priceInThousands)
            : null;
        const method = splitMeta.paymentMethod ?? null;
        return (
          <span
            key={d.storeId}
            className="inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-[var(--c-capsule)] px-1.5 py-0.5 text-label"
          >
            <span className="font-medium text-[var(--c-fg)]">{storeName}</span>
            {singleStore ? null : (
              <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
                {formatQty(d.qty)} {unit}
              </span>
            )}
            {overridePrice ? (
              <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
                @{overridePrice}{priceInThousands ? 'K' : ''}
              </span>
            ) : null}
            {method === 'transfer' ? (
              <span className="text-[var(--c-action)]">
                {i18n.t('run.label.paymentTransfer')}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  ) : null;

  /**
   * Q7(b) — the price editor is opt-in (2026-07-26).
   *
   * "大都数物品价格不是每天都会变化的，只有个别的价格会变，所以默认不显示价格
   * 输入，需要输入价格要点击具体的物品."
   *
   * A pending row used to carry the whole qty × price × method × ✓ grid,
   * on every one of several hundred items. Most of them cost the same as
   * last trip, so that grid was noise pushing the rows that DO need
   * attention off the screen. Now a row that already has a reference
   * price renders as one line with the carried value and a single ✓;
   * tapping anywhere on it opens the editor. A row with NO reference
   * price cannot be one-tapped and says so.
   *
   * Tap economics are the point, and they are neutral-to-better:
   * unchanged item stays one tap (✓, exactly as before), changed item is
   * tap-row → type → Enter, which is the same three actions as
   * tap-field → type → tap-✓. What changes is how many rows fit on the
   * screen at once.
   */
  const collapsedState = priceRowState({
    status: item.status,
    lastPrice,
    expanded: priceEditorOpen,
  });

  /* Price confidence — three bands, and the default one is silence.
   * See AGING_DAYS / GUESS_DAYS in lib/priceState.ts for why this does
   * not reuse STALE_PRICE_DAYS. */
  const ageDays = priceAgeDays(lastPriceObservedAt, Date.now());
  const confidence: 'fresh' | 'aging' | 'guess' | 'none' = !lastPrice
    ? 'none'
    : ageDays === null || ageDays <= AGING_DAYS
      ? 'fresh'
      : ageDays <= GUESS_DAYS
        ? 'aging'
        : 'guess';
  const moneyInk =
    confidence === 'guess' || confidence === 'none'
      ? 'text-[var(--c-warning-fg)]'
      : 'text-[var(--c-fg)]';

  const refPriceText = lastPrice
    ? priceInThousands
      ? `${formatMoney(Number(lastPrice) / 1000)}K`
      : formatMoney(lastPrice)
    : '';
  /* In thousands mode the visible figure is scaled, so long-press has to
   * be able to recover the real one. */
  const rawPriceTitle = (raw: string | null | undefined) =>
    priceInThousands && raw ? `${formatMoney(raw)} ${currency}` : undefined;

  const isTransfer = item.paymentMethod === 'transfer';
  const isAdded = item.addedByPurchaser === true;
  /* A row carrying per-store payment overrides has no single method, so
   * a one-tap switch would be a lie about what it is changing. Those
   * rows show a static indicator and are corrected in the sheet, which
   * is where the per-store fields exist. */
  const perStorePayment = actualSplits.some((s) => s.paymentMethod != null);
  const paymentLabel = i18n.t(
    isTransfer ? 'run.label.paymentTransfer' : 'run.label.paymentCash',
  );
  const paymentAria = `${i18n.t('run.label.paymentMethod')}: ${paymentLabel}`;

  if (item.status === 'pending' && collapsedState !== 'editing') {
    const carried = collapsedState === 'carried';
    return (
      // data-run-item-pending (2026-07-30): the "N left" button in the
      // bottom bar scrolls to the first one of these. A marker attribute
      // rather than a ref chain because the rows are rendered by four
      // different view components (flat / per-store / per-vendor /
      // per-category) and threading a ref through all of them to support
      // one scroll-into-view would cost far more than it's worth.
      <li data-run-item-pending className="border-b border-[var(--c-divider)] last:border-b-0">
        <div className={ROW_SHELL}>
          <button
            type="button"
            onClick={() => setPriceEditorOpen(true)}
            // No aria-label. It used to be {skuName}, which REPLACED the
            // accessible name computed from the contents — so a screen
            // reader announced the product and dropped the quantity, the
            // carried price and the freshness. The button's own text is
            // already the right name; the accordion headers in
            // RunPanels.tsx carry the same reasoning. `title` is
            // supplementary: with content present it never becomes the
            // accessible name.
            title={i18n.t(carried ? 'run.action.recordPurchase' : 'run.price.fillIn')}
            className={ROW_TAP}
            style={{ gridTemplateColumns: ROW_TRACKS }}
          >
            <RowStateCell
              kind={saving ? 'saving' : carried ? 'pending' : 'unpriced'}
              label={i18n.t(
                carried ? 'run.extras.status.pending' : 'run.price.fillIn',
              )}
            />

            {/* The ONLY element on this row permitted to lose
                characters — and it carries a `title`, because Cyrillic
                and Uzbek catalogue names disambiguate at the END
                ("...рафинированное" vs "...нерафинированное",
                "охлаждённое" vs "замороженное") and CSS ellipsis eats
                exactly that suffix. Long-press is the recovery; opening
                the row is the other. */}
            <span
              className="min-w-0 truncate text-body font-semibold text-[var(--c-fg)]"
              title={skuName}
            >
              {skuName}
            </span>

            {/* shrink-0 + nowrap: a number never truncates and never
                wraps. Right-aligned so it lands in a column. */}
            <span className="shrink-0 whitespace-nowrap text-right text-label text-[var(--c-fg-muted)]">
              <span className="font-mono tabular-nums">{formatQty(item.plannedQty)}</span>{' '}
              {unit}
            </span>

            {/* The money column. font-mono tabular-nums finally does
                something, because this is a fixed-floor right-aligned
                cell rather than the tail of a variable-length
                "qty · unit · ↺ · price · 31 天前" sentence. "Which row's
                price is 3x normal" becomes a vertical scan.

                "?" rather than a localized pill: ru "Указать цену" is
                ~66px and uz "Narx kiriting" ~72px, either of which blows
                the 68px floor and takes ~60px from the name on every
                unpriced row. It pairs with "~" as one three-mark
                notation — nothing / ~ / ? — and the localized phrase
                still reaches a screen reader and a long-press. */}
            <span
              className={`shrink-0 whitespace-nowrap text-right font-mono text-label font-semibold tabular-nums ${moneyInk}`}
              title={carried ? rawPriceTitle(lastPrice) : i18n.t('run.price.fillIn')}
            >
              {carried ? (
                <>
                  {confidence !== 'fresh' ? <span aria-hidden>~</span> : null}
                  {refPriceText}
                  {confidence !== 'fresh' && ageDays !== null ? (
                    <span className="sr-only">
                      {' '}
                      {i18n.t('run.price.daysAgo', { n: ageDays })}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <span aria-hidden>?</span>
                  <span className="sr-only">{i18n.t('run.price.fillIn')}</span>
                </>
              )}
            </span>
          </button>

          {/* This state's one control: commit. Rendered in BOTH variants
              so the right edge never changes shape down the list — the
              unpriced row used to end in a ~22px pill and no ✓ at all,
              two shapes at two heights, which is its own mis-tap
              generator. canSave is already false without a price, so no
              extra branch is needed.

              Mark-unavailable moved into the expanded editor. It ran at
              40x20px on all 87 rows while being used on 3.55% of them
              (152 of 4,276 rows in production; worst trip 9 of 83) —
              those ~48px are what the money column is made of. */}
          <button
            type="button"
            onClick={() => handleSave('collapsed')}
            disabled={!canSaveCollapsed}
            aria-busy={saving || undefined}
            aria-label={i18n.t('run.action.savePurchaseAriaLabel', { name: skuName })}
            className={`${ROW_CTRL} ${canSaveCollapsed ? CTRL_COMMIT : CTRL_OFF}`}
          >
            <span aria-hidden>✓</span>
          </button>
        </div>
        {showBreakdown ? <div className={SUBLINE}>{breakdownChips}</div> : null}
      </li>
    );
  }

  if (item.status === 'pending') {
    return (
      <li className="border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
        {/* Line 1: name + meta (planned · last price) + N/A.
            One row instead of two — meta sits on the same baseline as the
            title in muted 12px so it's scannable but not distracting. */}
        <div className="flex items-baseline gap-2">
          {/* M2.2: pending-row primary unified to text-body
              font-semibold (was text-h3 = 15px, mismatched with the
              same role on Order/Confirm pages). */}
          {/* Wraps instead of truncating: opening a row is how you read
              a name the collapsed row had to clip, which matters because
              Cyrillic names disambiguate at the end and the ellipsis
              eats that. Was `shrink-0 truncate`, i.e. dead CSS that made
              the qty and price the compressible things instead. */}
          <span className="min-w-0 break-words text-body font-semibold">{skuName}</span>
          <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
            {formatQty(item.plannedQty)} {unit}
            {lastPrice ? (
              <>
                {' · '}
                {/* M3.36: in thousands mode the lastPrice hint is shown
                   as the same scale the user is typing — so a row that
                   says "K·UZS" with input "147.5" lines up with a hint
                   "147.5K" rather than "147,500". Tooltip preserves the
                   raw UZS for a long-press inspection. */}
                <span
                  className="font-mono tabular-nums"
                  title={priceInThousands ? `${formatMoney(lastPrice)} ${currency}` : undefined}
                >
                  {priceInThousands
                    ? `${formatMoney(Number(lastPrice) / 1000)}K`
                    : formatMoney(lastPrice)}
                </span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => onMarkNa(item.skuId)}
            className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-capsule)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
          >
            {i18n.t('run.action.markNa')}
          </button>
        </div>
        {/* M3.52: per-store demand breakdown chips. Render only when
            multi-store; positioned BETWEEN the title row and the
            qty/price input row so the purchaser sees per-store
            allocation BEFORE typing the actual qty (they may want to
            confirm with each store's manager that the planned split
            still applies if the qty diverges). */}
        {showBreakdown ? <div className="mt-1">{breakdownChips}</div> : null}
        {/* Line 2: qty × price = total ✓ — everything on one line.
            Total hint is inline (right of price, before ✓) so the user
            sees their math without an extra row. */}
        {/* 2026-07-30: two changes here, both forced by making the price
            UNIT switchable (the K·UZS button below).

            a) The price track gained a 4.25rem floor. It was
               `minmax(0,1fr)` — flexible but collapsible — which was fine
               while every price was 2-3 digits in thousands mode, and
               clipped hard in plain UZS: "30000" rendered as "300". That
               clipping is plausibly WHY ×1000 was defaulted on to begin
               with. Plain mode is now a real choice, so it has to be
               readable.

            b) The `= total` readout moved OUT of this grid onto its own
               line below. Seven tracks never fit 375 px once the price
               needed 5-6 digits — squeezing them made the total collapse
               to "= 3…" and then to nothing. It's a readout, not an
               input, and it's the safety net against the ×1000 mistake,
               so it gets a full line where it can't be truncated. The
               price stays the single flexible track, which keeps the
               payment-button note below accurate. */}
        <div className="mt-1.5 grid items-center gap-1.5"
             style={{ gridTemplateColumns: '4.5rem auto minmax(4.25rem,1fr) auto auto auto' }}>
          {/* 2026-07-26 keyboard pass. Both fields arrive PRE-FILLED
              (qty from planned, price from the last observed market
              price), so a tap that appends instead of replacing is the
              common failure — hence select-on-focus. Enter chains
              qty → price → save so a changed price is three actions
              (tap, type, Enter) instead of tap-type-reach-for-✓. */}
          <NumberInput
            step={step}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            enterKeyHint="next"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              priceRef.current?.focus();
            }}
            aria-label={i18n.t('run.action.actualQtyAriaLabel')}
          />
          <span className="text-body text-[var(--c-fg-muted)]">×</span>
          <NumberInput
            ref={priceRef}
            // Without a step, type="number" defaults to 1 — which makes
            // every fractional value a stepMismatch. In thousands mode
            // the displayed price IS fractional (147500 → "147.5"), so
            // the field sat :invalid the whole time it was in use.
            // "any" is the honest constraint: a market price has no
            // fixed granularity. qty keeps the SKU's real step.
            step="any"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            enterKeyHint="done"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (canSave) handleSave('editor');
            }}
            placeholder={i18n.t('run.action.unitPriceAriaLabel')}
            aria-label={i18n.t('run.action.unitPriceAriaLabel')}
          />
          {/* The unit suffix IS the toggle (2026-07-30). It already had to
              be here to disambiguate "20" from "20,000"; making it tappable
              costs no layout and puts the control at the point of use. */}
          <button
            type="button"
            onClick={onTogglePriceUnit}
            aria-label={i18n.t('run.label.priceUnitAria')}
            className="press shrink-0 rounded-[var(--r-utility)] px-1 text-label text-[var(--c-action)] underline decoration-dotted underline-offset-2 active:opacity-70"
          >
            {priceInThousands ? `K·${currency}` : currency}
          </button>
          {/* M1.14: payment-method toggle. Defaults to cash; tap to flip
              to transfer. Sits before ✓ save so the muscle memory is
              "set method → confirm".
              2026-07-30: the label is now ON the control instead of only
              in a tooltip — there is no long-press tooltip on touch. */}
          <button
            type="button"
            onClick={() =>
              setPaymentMethod((m) => (m === 'cash' ? 'transfer' : 'cash'))
            }
            // aria-pressed + a label that names the CONTROL, not just
            // its current face. The old label announced "cash" with no
            // indication that it was a toggle or what tapping would do;
            // the ×1000 toggle two files away already gets this right.
            aria-pressed={paymentMethod === 'transfer'}
            aria-label={`${i18n.t('run.label.paymentMethod')}: ${i18n.t(
              paymentMethod === 'cash'
                ? 'run.label.paymentCash'
                : 'run.label.paymentTransfer',
            )}`}
            title={
              paymentMethod === 'cash'
                ? i18n.t('run.label.paymentCash')
                : i18n.t('run.label.paymentTransfer')
            }
            className={
              // 2026-07-26: was h-8 min-w-8 (32px). This row is tapped
              // hundreds of times per trip, one-handed, standing, often
              // with wet hands — 32px is below every touch-target
              // guideline and the misses cost a wrong record.
              //
              // Height is free, width is not: this button sits in a grid
              // (see gridTemplateColumns above) whose only flexible track
              // is the PRICE input, and `auto` tracks are maximized before
              // `fr` tracks expand — so every pixel taken here comes
              // straight out of the field the purchaser has to read back
              // to the vendor. Hence 44px tall but only 36px wide
              // (min-w-9), which costs the price field ~5px instead of
              // ~21px. Do not widen this to min-w-11 without also giving
              // column 3 a floor.
              //
              // The height is --control-h-touch, the ladder's restricted
              // 44px `touch` tier (tokens.css documents when it applies).
              'flex h-[var(--control-h-touch)] min-w-9 items-center justify-center rounded-[var(--r-pill)] px-1.5 text-label font-medium active:opacity-70 ' +
              (paymentMethod === 'transfer'
                ? 'bg-[var(--c-info-bg)] text-[var(--c-action)]'
                : 'bg-[var(--c-capsule)] text-[var(--c-fg-muted)]')
            }
          >
            {/* 2026-07-30: was a bare 💵/🏦. The comment on the sibling
                control below already conceded the weakness — "colour emoji
                ignore the ink token, so 💵 vs 🏦 alone is a weak signal at
                arm's length in sunlight" — and compensated with container
                colour. The word is the signal; colour is now reinforcement
                rather than the only carrier. Two CJK glyphs at text-label
                fit the same 36 px slot the emoji occupied. */}
            {paymentMethod === 'cash'
              ? i18n.t('run.label.paymentCash')
              : i18n.t('run.label.paymentTransfer')}
          </button>
          <button
            type="button"
            onClick={() => handleSave('editor')}
            disabled={!canSave}
            aria-busy={saving || undefined}
            aria-label={i18n.t('run.action.savePurchaseAriaLabel', { name: skuName })}
            className={
              // 44px tall (--control-h-touch) / 36px wide — see the
              // payment-method button above for why the width is
              // deliberately not 44. This is the control that commits
              // money, so it is the last one that should be hard to hit.
              'flex h-[var(--control-h-touch)] min-w-9 items-center justify-center rounded-[var(--r-pill)] px-2 text-body font-semibold ' +
              (canSave
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)] active:opacity-80'
                : 'bg-[var(--c-capsule)] text-[var(--c-fg-muted)]')
            }
          >
            ✓
          </button>
        </div>
        {/* Line 3: the computed total, on its own line (2026-07-30).
            This is the readout that catches a ×1000 slip — "I typed 30,
            that's 30,000 som" — so it must never be the thing that gets
            truncated when the row runs out of width. Right-aligned under
            the price it belongs to. */}
        {totalHint !== null ? (
          <div className="mt-1 pr-1 text-right text-label text-[var(--c-fg-muted)]">
            ={' '}
            <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">
              {formatMoney(totalHint)}
            </span>{' '}
            {currency}
          </div>
        ) : null}
      </li>
    );
  }

  if (item.status === 'purchased') {
    return (
      <li className="border-b border-[var(--c-divider)] last:border-b-0">
        <div className={ROW_SHELL}>
          <button
            type="button"
            onClick={() => onEdit(item)}
            title={i18n.t('run.action.editPurchase')}
            className={ROW_TAP}
            style={{ gridTemplateColumns: ROW_TRACKS }}
          >
            <RowStateCell kind="purchased" label={i18n.t('run.extras.status.bought')} />

            <span className="flex min-w-0 items-baseline gap-1">
              {/* One ink level down: finished work recedes so the eye
                  finds what is left. */}
              <span
                className="min-w-0 truncate text-body font-semibold text-[var(--c-fg-muted)]"
                title={skuName}
              >
                {skuName}
              </span>
              {isAdded ? (
                /* M3.41: marks rows the purchaser added mid-run. Was
                   bg-[--c-warning]/15 + ring-[--c-warning] + warning ink
                   — three uses of the alarm channel on one 16px badge.
                   "Added by the purchaser" is information for whoever
                   approves the run, not an instruction to the person
                   holding the phone, so it leaves the channel that means
                   "act or this trip is wrong". Shape kept, alarm gone. */
                <span
                  title={i18n.t('run.label.addedByPurchaser')}
                  className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-capsule)] px-1.5 text-label text-[var(--c-fg-muted)]"
                >
                  <span aria-hidden>+</span>
                  <span className="sr-only">{i18n.t('run.label.addedByPurchaser')}</span>
                </span>
              ) : null}
            </span>

            {/* Same track, same meaning as every other state: quantity.
                Planned while pending, actual once bought. */}
            <span className="shrink-0 whitespace-nowrap text-right text-label text-[var(--c-fg-muted)]">
              <span className="font-mono tabular-nums">{formatQty(item.purchasedQty)}</span>{' '}
              {unit}
            </span>

            {/* UNIT price, never the line total. A column that answers a
                different question in each state is not a column, and the
                unit price is the only figure comparable row-to-row —
                which is the whole point of giving money a column. The
                line total moves to sr-only; it is also live in the
                expanded editor, which is where it gets read (before
                paying, not after). */}
            <span
              className="shrink-0 whitespace-nowrap text-right font-mono text-label font-semibold tabular-nums text-[var(--c-fg)]"
              title={rawPriceTitle(item.unitPrice)}
            >
              {priceInThousands && item.unitPrice
                ? `${formatMoney(Number(item.unitPrice) / 1000)}K`
                : formatMoney(item.unitPrice)}
              {Number(item.purchasedQty) > 0 && Number(item.unitPrice) > 0 ? (
                <span className="sr-only">
                  {' = '}
                  {formatMoney(
                    Number(item.purchasedQty) * Number(item.unitPrice),
                    currency,
                  )}
                </span>
              ) : null}
            </span>
          </button>

          {/* This state's one control: the payment method.
              Cash used to render NOTHING at all, so there was no object
              to notice and no way to correct it from the list — and
              since the one-tap ✓ has no method control and defaults to
              cash, totalCash / totalTransfer drift by construction.
              Every purchased row now shows its method as a persistent,
              tappable object at a fixed x. */}
          {perStorePayment ? (
            <span
              className={`${ROW_CTRL} ${isTransfer ? CTRL_TRANSFER : CTRL_QUIET}`}
              title={i18n.t('run.label.paymentMethod')}
            >
              <span className="text-label font-medium">{paymentLabel}</span>
              <span className="sr-only">{paymentAria}</span>
            </span>
          ) : (
            <button
              type="button"
              // aria-pressed so the control announces that it IS a
              // toggle and which way it currently sits. The CONTAINER
              // carries the visual state, not the emoji: colour emoji
              // ignore the ink token, so 💵 vs 🏦 alone is a weak signal
              // at arm's length in sunlight.
              aria-pressed={isTransfer}
              aria-label={paymentAria}
              title={paymentLabel}
              disabled={paymentBusy}
              onClick={() => onSetPaymentMethod(item, isTransfer ? 'cash' : 'transfer')}
              className={`${ROW_CTRL} ${
                paymentBusy ? CTRL_OFF : isTransfer ? CTRL_TRANSFER : CTRL_QUIET
              }`}
            >
              <span className="text-label font-medium">{paymentLabel}</span>
            </button>
          )}
        </div>
        {/* M3.52: per-store ACTUAL allocation — how many kg/pcs to bag
            for each store. May differ from planned demand when the qty
            bought diverged. */}
        {showBreakdown ? <div className={SUBLINE}>{breakdownChips}</div> : null}
      </li>
    );
  }

  // unavailable
  return (
    <li className="border-b border-[var(--c-divider)] last:border-b-0">
      <div className={ROW_SHELL}>
        {/* A dropped row has nothing to open, so this is a <div>:
            identical geometry, no false affordance, and no way to
            fat-finger a closed line while walking. */}
        <div className={ROW_STATIC} style={{ gridTemplateColumns: ROW_TRACKS }}>
          <RowStateCell kind="unavailable" label={i18n.t('run.extras.status.unavailable')} />

          {/* line-through is a TEXTURE difference, so "dropped" survives
              greyscale without spending --c-danger on the eye. Muted,
              not subtle: --c-fg-subtle is 3.22:1 and the purchaser still
              has to find this row by name when the vendor restocks. */}
          <span
            className="min-w-0 truncate text-body font-semibold text-[var(--c-fg-muted)] line-through"
            title={skuName}
          >
            {skuName}
          </span>

          {/* The qty stays: what you FAILED to get is a number the
              kitchen needs, and it keeps the column continuous. */}
          <span className="shrink-0 whitespace-nowrap text-right text-label text-[var(--c-fg-muted)]">
            <span className="font-mono tabular-nums">{formatQty(item.plannedQty)}</span>{' '}
            {unit}
          </span>

          {/* Nothing was paid. The dash holds the track open so the list
              stays a grid and says "no number here" rather than leaving
              a gap that reads as a rendering fault. Decorative and
              aria-hidden — the one place --c-fg-subtle is used, which is
              what that ink is for. */}
          <span
            aria-hidden
            className="shrink-0 text-right font-mono text-label tabular-nums text-[var(--c-fg-subtle)]"
          >
            —
          </span>
        </div>

        {/* This state's one control: put it back. Already routes through
            RunPage's ConfirmSheet. */}
        <button
          type="button"
          onClick={() => onUnmark(item.skuId, skuName)}
          aria-label={i18n.t('run.action.unmarkUnavailableAriaLabel', { name: skuName })}
          title={i18n.t('run.action.unmarkUnavailable')}
          className={`${ROW_CTRL} ${CTRL_QUIET}`}
        >
          <span aria-hidden>↺</span>
        </button>
      </div>

      {/* The note is prose, so it cannot live in a number track. Second
          line, indented to the name's left edge, only when there is one.
          It used to sit in the flex-1 meta span, where it was the first
          thing a long name deleted. */}
      {item.unavailableNote ? (
        <p
          className={`${SUBLINE} truncate text-label text-[var(--c-fg-muted)]`}
          title={item.unavailableNote}
        >
          {item.unavailableNote}
        </p>
      ) : null}
    </li>
  );
}
