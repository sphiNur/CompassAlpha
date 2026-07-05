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
import { formatMoney, formatQty } from '../../../lib/format';
import { useI18n } from '../../../hooks/useI18n';
import { toDisplayPrice, fromDisplayPrice } from '../lib/priceMath';
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
                            {e.qty} {e.unit}
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
                  runItem: run.items.find((it) => it.skuId === r.skuId) ?? null,
                }))
                .sort((a, b) => {
                  const ai = a.sku?.id ? 0 : 1;
                  const bi = b.sku?.id ? 0 : 1;
                  if (ai !== bi) return ai - bi;
                  const an = a.sku ? productName(a.sku) : a.skuId;
                  const bn = b.sku ? productName(b.sku) : b.skuId;
                  return an.localeCompare(bn);
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
                        {formatQty(r.qty)} {r.sku?.unit ?? ''}
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
  savingSkuId,
  demandBySku,
  onSavePurchaseInline,
  onMarkNa,
  onUndoPurchase,
  onOpenAdvancedPurchase,
  onEditPurchased,
  onUnmark,
  onMarkExtraStatus,
  onRecordExtraExpense,
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
  demandBySku: Map<string, Array<{ storeId: string; qty: string }>>;
  onSavePurchaseInline: (payload: {
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
  onUndoPurchase: (skuId: string, skuName: string) => void;
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
}) {
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
                  // M3.43: keep pending rows on top so the purchaser
                  // sees what's left to buy at this stall before the
                  // already-resolved (purchased / N/A) rows below. The
                  // aggregate view sorts by sortIndex; here the stall
                  // grouping makes "still TODO at this stall" the
                  // more useful first-line ordering.
                  const order: Record<string, number> = {
                    pending: 0,
                    purchased: 1,
                    unavailable: 2,
                  };
                  const oa = order[a.status] ?? 3;
                  const ob = order[c.status] ?? 3;
                  if (oa !== ob) return oa - ob;
                  const ai = a.sku ? 0 : 1;
                  const bi = c.sku ? 0 : 1;
                  if (ai !== bi) return ai - bi;
                  const an = a.sku ? productName(a.sku) : a.skuId;
                  const bn = c.sku ? productName(c.sku) : c.skuId;
                  return an.localeCompare(bn);
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
                  const runItem = run.items.find((it) => it.skuId === r.skuId);
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
                          {formatQty(r.plannedQty)} {r.sku?.unit ?? ''}
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
                  const actualSplits = run.splits
                    .filter((sp) => sp.skuId === r.skuId)
                    .map((sp) => ({
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
                      unit={r.sku?.unit ?? ''}
                      step={r.sku?.step ?? '0.1'}
                      demand={demandBySku.get(r.skuId) ?? []}
                      storeById={storeById}
                      actualSplits={actualSplits}
                      isMultiStoreRun={isMultiStoreRun}
                      lastPrice={run.lastPriceBySku?.[r.skuId] ?? null}
                      i18n={i18n}
                      priceInThousands={priceInThousands}
                      saving={savingSkuId === r.skuId}
                      onSave={onSavePurchaseInline}
                      onMarkNa={onMarkNa}
                      onEdit={onEditPurchased}
                      onUnmark={onUnmark}
                      onUndoPurchase={onUndoPurchase}
                      onOpenAdvanced={onOpenAdvancedPurchase}
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
        editable={run.status === 'purchasing'}
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
                          {e.qty} {e.unit}
                        </span>
                      </>
                    );
                    return (
                      <li
                        key={`${e.sessionId ?? storeId}-${e.idx ?? idx}-${e.name}`}
                        className="text-body-sm"
                      >
                        <div className="-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-1 rounded-md px-2 py-0.5">
                          {canTap ? (
                            <button
                              type="button"
                              title={i18n.t('run.extras.status.cycleHint', { current: v.label })}
                              onClick={() =>
                                onMarkExtraStatus!(e.sessionId!, e.idx!, cycle(status))
                              }
                              className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md text-left active:bg-[var(--c-surface-2)]"
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
                              className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-2 py-0.5 text-label font-medium text-[var(--c-action)] ring-hairline active:opacity-70"
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
            className="rounded-[var(--r-pill)] bg-[var(--c-action)] px-2.5 py-1 text-label font-semibold text-[var(--c-action-fg)] active:opacity-70"
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
                <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-1.5 py-0.5 text-label text-[var(--c-fg-muted)] ring-hairline">
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
                    className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-action)]/15 px-1.5 py-0.5 text-label text-[var(--c-action)] ring-1 ring-[var(--c-action)]"
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
                    className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-danger)] active:bg-[var(--c-surface-2)]"
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
  savingSkuId,
  demandBySku,
  onSavePurchaseInline,
  onMarkNa,
  onUndoPurchase,
  onOpenAdvancedPurchase,
  onEditPurchased,
  onUnmark,
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
  savingSkuId: string | null;
  demandBySku: Map<string, Array<{ storeId: string; qty: string }>>;
  onSavePurchaseInline: (payload: {
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
  onEditPurchased: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  onUndoPurchase: (skuId: string, skuName: string) => void;
  onOpenAdvancedPurchase: (item: ActiveRun['items'][number]) => void;
}) {
  const demandStoreIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of run.perStoreDemand ?? []) ids.add(d.storeId);
    if (ids.size === 0) for (const sp of run.splits) ids.add(sp.storeId);
    return [...ids];
  }, [run.perStoreDemand, run.splits]);
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
            ? '未分类'
            : productName(categoryById.get(categoryId) ?? { names: { zh: categoryId.slice(0, 8) } }),
        items,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categoryById, productName, run.items, skuById]);

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
              const actualSplits = run.splits
                .filter((sp) => sp.skuId === item.skuId)
                .map((sp) => ({
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
                  unit={sku?.unit ?? ''}
                  step={sku?.step ?? '0.1'}
                  demand={demandBySku.get(item.skuId) ?? []}
                  storeById={storeById}
                  actualSplits={actualSplits}
                  isMultiStoreRun={demandStoreIds.length > 1}
                  lastPrice={run.lastPriceBySku?.[item.skuId] ?? null}
                  i18n={i18n}
                  priceInThousands={priceInThousands}
                  saving={savingSkuId === item.skuId}
                  onSave={onSavePurchaseInline}
                  onMarkNa={onMarkNa}
                  onEdit={onEditPurchased}
                  onUnmark={onUnmark}
                  onUndoPurchase={onUndoPurchase}
                  onOpenAdvanced={onOpenAdvancedPurchase}
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
  i18n,
  priceInThousands,
  saving,
  onSave,
  onMarkNa,
  onEdit,
  onUnmark,
  onUndoPurchase,
  onOpenAdvanced,
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
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, the price input shows raw UZS / 1000. Save still
   *  emits raw UZS. */
  priceInThousands: boolean;
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
  onUndoPurchase: (skuId: string, skuName: string) => void;
  onOpenAdvanced: (item: ActiveRun['items'][number]) => void;
}) {
  // Default qty = planned (formatted to 1 decimal). Price defaults to
  // the last observed market price for this SKU — saves typing when
  // prices are unchanged from the previous run, which is the common
  // case for staple goods. User can overwrite.
  const [qty, setQty] = useState<string>(
    formatQty(item.purchasedQty ?? item.plannedQty),
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

  // When server data updates (e.g. ws push, edit landed), reconcile
  // the local input values UNLESS the user is mid-edit (the row is
  // pending and they may have typed something we shouldn't clobber).
  useEffect(() => {
    if (item.status === 'pending') return;
    setQty(formatQty(item.purchasedQty ?? item.plannedQty));
    setPrice(toDisplayPrice(item.unitPrice ?? lastPrice ?? '', priceInThousands));
  }, [item.status, item.purchasedQty, item.unitPrice, item.plannedQty, lastPrice, priceInThousands]);

  // M3.36: when the page-level toggle flips while a row is mid-edit
  // (pending), rescale the displayed price so the same underlying
  // UZS value rides through the mode change. Without this, flipping
  // mid-typing would silently mis-scale the next save (e.g. user
  // typed 147500 in raw mode, toggles K mode → handleSave would
  // re-multiply ×1000 → 147,500,000).
  const prevThousandsRef = useRef(priceInThousands);
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
  const computeProportionalSplits = (
    actualQtyStr: string,
  ): Array<{ storeId: string; qty: string }> | null => {
    if (demand.length === 0) return null;
    const actualQtyNum = Number(actualQtyStr);
    if (!Number.isFinite(actualQtyNum) || actualQtyNum <= 0) return null;
    const plannedTotal = demand.reduce((s, d) => s + Number(d.qty), 0);
    if (plannedTotal <= 0) return null;
    if (demand.length === 1) {
      // Trivial single-store case — no proportional math needed.
      return [{ storeId: demand[0]!.storeId, qty: actualQtyStr }];
    }
    const out: Array<{ storeId: string; qty: string }> = [];
    let allocated = 0;
    for (let i = 0; i < demand.length; i++) {
      const d = demand[i]!;
      let qtyStr: string;
      if (i === demand.length - 1) {
        // Last store absorbs rounding error so the sum is exact.
        qtyStr = (actualQtyNum - allocated).toFixed(3);
      } else {
        const portion = (Number(d.qty) / plannedTotal) * actualQtyNum;
        qtyStr = portion.toFixed(3);
        allocated += Number(qtyStr);
      }
      out.push({ storeId: d.storeId, qty: qtyStr });
    }
    return out;
  };

  const handleSave = () => {
    if (item.status !== 'pending') return;
    if (saving) return;
    const actualQty = qty.trim();
    const displayPrice = price.trim();
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
      storeSplits: splits,
      paymentMethod,
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
            className="inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-1.5 py-0.5 text-label ring-1 ring-[var(--c-divider)]"
          >
            <span className="font-medium text-[var(--c-fg)]">{storeName}</span>
            <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
              {formatQty(d.qty)} {unit}
            </span>
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
          <span className="shrink-0 truncate text-body font-semibold">{skuName}</span>
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
            className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
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
        <div className="mt-1.5 grid items-center gap-1.5"
             style={{ gridTemplateColumns: '4.5rem auto minmax(0,1fr) auto minmax(0,auto) auto auto' }}>
          <NumberInput
            step={step}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="actual qty"
          />
          <span className="text-body text-[var(--c-fg-muted)]">×</span>
          <NumberInput
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="price"
            aria-label="unit price"
          />
          <span className="text-label text-[var(--c-fg-muted)]">
            {priceInThousands ? `K·${currency}` : currency}
          </span>
          <span className="truncate text-right text-label text-[var(--c-fg-muted)]">
            {totalHint !== null ? (
              <>
                ={' '}
                <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">
                  {formatMoney(totalHint)}
                </span>
              </>
            ) : null}
          </span>
          {/* M1.14: payment-method toggle. Default 💵 cash; tap to
              flip to 🏦 transfer. Sits before ✓ save so the muscle
              memory is "set method → confirm". Tooltip on long-press
              spells out the active label for accessibility. */}
          <button
            type="button"
            onClick={() =>
              setPaymentMethod((m) => (m === 'cash' ? 'transfer' : 'cash'))
            }
            aria-label={
              paymentMethod === 'cash'
                ? i18n.t('run.label.paymentCash')
                : i18n.t('run.label.paymentTransfer')
            }
            title={
              paymentMethod === 'cash'
                ? i18n.t('run.label.paymentCash')
                : i18n.t('run.label.paymentTransfer')
            }
            className={
              'flex h-8 min-w-8 items-center justify-center rounded-[var(--r-pill)] px-2 text-body active:opacity-70 ' +
              (paymentMethod === 'transfer'
                ? 'bg-[var(--c-action)]/15 text-[var(--c-action)] ring-1 ring-[var(--c-action)]'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
            }
          >
            {paymentMethod === 'cash' ? '💵' : '🏦'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            aria-busy={saving || undefined}
            aria-label="save purchase"
            className={
              'flex h-8 min-w-8 items-center justify-center rounded-[var(--r-pill)] px-2.5 text-body font-semibold ' +
              (canSave
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)] active:opacity-80'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
            }
          >
            ✓
          </button>
        </div>
      </li>
    );
  }

  if (item.status === 'purchased') {
    /* Single line: ✓ name · qty unit × price = total   [edit] [undo]
       Was a two-line block; the badge + math is now inline and the
       row actions slim down to icon buttons. */
    const total =
      Number(item.purchasedQty) > 0 && Number(item.unitPrice) > 0
        ? formatMoney(Number(item.purchasedQty) * Number(item.unitPrice))
        : null;
    // M1.14: show 🏦 next to transfer purchases so the purchaser can
    // scan the run at a glance and see which items hit the bank wire.
    // Cash is the implicit default — no icon needed (avoids visual
    // noise on the 90%+ rows that are cash).
    const isTransfer = item.paymentMethod === 'transfer';
    const isAdded = item.addedByPurchaser === true;
    return (
      <li className="border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
        <div className="flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-body text-[var(--c-success)]">✓</span>
          <span className="shrink-0 truncate text-body font-semibold">{skuName}</span>
          {isAdded ? (
            // M3.41 (2026-05-21): "+" badge marks rows the purchaser added
            // mid-run. The +ring outline disambiguates from the 🏦 transfer
            // pill (which uses the same action accent). Tooltip carries
            // the localized "added by purchaser" label.
            <span
              aria-label={i18n.t('run.label.addedByPurchaser')}
              title={i18n.t('run.label.addedByPurchaser')}
              className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-warning)]/15 px-1.5 py-0.5 text-label text-[var(--c-warning)] ring-1 ring-[var(--c-warning)]"
            >
              +
            </span>
          ) : null}
          {isTransfer ? (
            <span
              aria-label={i18n.t('run.label.paymentTransfer')}
              title={i18n.t('run.label.paymentTransfer')}
              className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-action)]/15 px-1.5 py-0.5 text-label text-[var(--c-action)] ring-1 ring-[var(--c-action)]"
            >
              {i18n.t('run.label.paymentTransfer')}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
            {formatQty(item.purchasedQty)} {unit} ×{' '}
            {/* M3.36: render persisted unitPrice in the same scale the
               user is currently working in — keeps the displayed math
               visually consistent with what they typed. */}
            {priceInThousands && item.unitPrice
              ? `${formatMoney(Number(item.unitPrice) / 1000)}K`
              : formatMoney(item.unitPrice)}
            {total ? (
              <>
                {' = '}
                <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">{total}</span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => onEdit(item)}
            aria-label={i18n.t('run.action.editPurchase')}
            className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
          >
            {i18n.t('run.action.editPurchase')}
          </button>
          <button
            type="button"
            onClick={() => onUndoPurchase(item.skuId, skuName)}
            aria-label={i18n.t('run.action.undoPurchase')}
            className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-danger)] active:bg-[var(--c-surface-2)]"
          >
            {i18n.t('run.action.undoPurchase')}
          </button>
        </div>
        {/* M3.52: per-store ACTUAL allocation chips. Sits below the
            aggregate qty/price/total row so the purchaser can — at
            a glance — see how many kg/pcs to bag for each store.
            Shows the post-purchase splits (run.splits filtered to
            this skuId), which may differ from planned demand when
            the actual qty bought diverged from planned. */}
        {showBreakdown ? <div className="mt-1">{breakdownChips}</div> : null}
      </li>
    );
  }

  // unavailable — single line: ✗ name · note   [unmark]
  return (
    <li className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
      <span aria-hidden className="shrink-0 text-body text-[var(--c-danger)]">✗</span>
      <span className="shrink-0 truncate text-body font-semibold">{skuName}</span>
      <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
        {item.unavailableNote ?? ''}
      </span>
      <button
        type="button"
        onClick={() => onUnmark(item.skuId, skuName)}
        className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
      >
        {i18n.t('run.action.unmarkUnavailable')}
      </button>
    </li>
  );
}
