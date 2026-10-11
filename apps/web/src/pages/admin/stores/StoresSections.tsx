/**
 * Admin → Stores sections — extracted verbatim from AdminPage.tsx
 * (Phase 5 step 3, FRONTEND_AUDIT_2026-07.md admin split).
 *
 *   - StoresHomeSection  store tiles + create-store sheet
 *   - StoreDetailScreen  drilled-in store: Team | Settings | Inventory
 *                        | Sales tab router
 *   - StoreInventoryTab / StoreSalesTab / StoreSettingsTab (internal)
 *   - StoreCloneRolesSheet clone-roles wizard (internal)
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Sheet,
  Spinner,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { formatMoney, formatQty } from '../../../lib/format';
import { useDateFormat, useI18n, useProductName, useUnitLabel } from '../../../hooks/useI18n';
import type { StoreFocus, StoreSub } from '../shared';
import { PeopleSection } from '../people/PeopleSections';
import { StoreSettings } from '../../../destinations/manage/StoreSettings';


// EMPTY_STORE was used by the old combined create/edit sheet; the
// store list now uses a small create-only sheet inline (just name +
// code + address + timezone — defaults set later in Settings tab).

// ============ Stores (M1.4 store-first) ============

/**
 * StoreDetailScreen (M1.4, 2026-05-06).
 *
 * Per-store detail page. Tab bar at the top:
 *   - Team — members in this store, with all the Manage / Grant /
 *            Permissions / Detach / Transfer affordances. Reuses the
 *            existing PeopleSection with `lockMode` set so the global
 *            StoreSwitcher is bypassed.
 *   - Settings — store fields (name/code/address/timezone), default
 *                role picker, archive button, clone-roles wizard.
 *
 * Org-level focus: only Team tab. Settings doesn't apply (the pseudo-
 * store has no DB row).
 */
export function StoreDetailScreen({
  focus,
  sub,
  onSubChange,
}: {
  focus: NonNullable<StoreFocus>;
  sub: StoreSub;
  onSubChange: (s: StoreSub) => void;
}) {
  const i18n = useI18n();
  const isOrgLevel = focus.kind === 'org-level';
  const effectiveSub: StoreSub = isOrgLevel ? 'team' : sub;
  return (
    <div className="flex flex-col">
      {!isOrgLevel ? (
        // M3.17 (2026-05-16): Team / Inventory / Sales / Settings tabs
        // migrated from local SegBtn → shared <Segmented>. M2.0a +
        // M2.0c notes preserved: Inventory shows on-hand + stocktake,
        // Sales records dish sales (auto-deducts via recipe BOM).
        <div
          role="tablist"
          aria-label={i18n.t('admin.store.sectionAria')}
          className="flex gap-sm overflow-x-auto px-page"
        >
          {(
            [
              ['team', 'admin.store.tabTeam'],
              ['inventory', 'admin.store.tabInventory'],
              ['sales', 'admin.store.tabSales'],
              ['settings', 'admin.store.tabSettings'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={effectiveSub === value}
              data-testid={`store-tab-${value}`}
              onClick={() => onSubChange(value)}
              className={
                'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70 ' +
                (effectiveSub === value ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink')
              }
            >
              {i18n.t(label)}
            </button>
          ))}
        </div>
      ) : null}
      {effectiveSub === 'team' ? (
        <PeopleSection
          lockMode={isOrgLevel ? { kind: 'org-level' } : { kind: 'store', storeId: focus.storeId }}
        />
      ) : null}
      {effectiveSub === 'inventory' && focus.kind === 'store' ? (
        <StoreInventoryTab storeId={focus.storeId} />
      ) : null}
      {effectiveSub === 'sales' && focus.kind === 'store' ? (
        <StoreSalesTab storeId={focus.storeId} />
      ) : null}
      {effectiveSub === 'settings' && focus.kind === 'store' ? (
        <StoreSettings storeId={focus.storeId} />
      ) : null}
    </div>
  );
}

/**
 * StoreInventoryTab (M2.0a, 2026-05-08).
 *
 * Lists current on-hand per SKU at this store, sourced from the
 * `inventory.movements` ledger via `inventory.levels(storeId)`. Two
 * actions per row:
 *
 *   - Stocktake: type the count from the shelf. We compute the delta
 *     and post a single ledger row.
 *   - Wastage: subtract qty with a mandatory note (spoiled / broken /
 *     mislabeled / lost).
 *
 * Recent-movements drill-down for "why is the on-hand X" lives on
 * the row tap (opens a sheet listing the last 50 movements).
 */
function StoreInventoryTab({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  // 2026-07-30 (flow review): on-hand quantities printed the raw canonical
  // unit while the rest of the app printed the localized label.
  const unitLabel = useUnitLabel();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const levelsQuery = trpc.inventory.levels.useQuery({ storeId });
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const utils = trpc.useUtils();

  const skuById = useMemo(() => {
    const m = new Map<
      string,
      { id: string; names: Record<string, string>; unit: string; step: string }
    >();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
      });
    }
    return m;
  }, [skusQuery.data]);

  type ActionMode =
    | { kind: 'stocktake'; skuId: string; current: string }
    | { kind: 'wastage'; skuId: string };

  const [action, setAction] = useState<ActionMode | null>(null);
  const [draftTarget, setDraftTarget] = useState('');
  const [draftWasteQty, setDraftWasteQty] = useState('');
  const [draftNote, setDraftNote] = useState('');

  useEffect(() => {
    if (!action) {
      setDraftTarget('');
      setDraftWasteQty('');
      setDraftNote('');
    } else if (action.kind === 'stocktake') {
      setDraftTarget(action.current);
    }
  }, [action]);

  const stocktake = trpc.inventory.stocktake.useMutation({
    onSuccess: () => {
      void utils.inventory.levels.invalidate({ storeId });
      toast.success(i18n.t('inventory.toast.stocktakeSaved'));
      setAction(null);
    },
    onError: errToast('common.error'),
  });
  const recordWastage = trpc.inventory.recordWastage.useMutation({
    onSuccess: () => {
      void utils.inventory.levels.invalidate({ storeId });
      toast.success(i18n.t('inventory.toast.wastageSaved'));
      setAction(null);
    },
    onError: errToast('common.error'),
  });

  const rows = useMemo(() => {
    const levels = levelsQuery.data ?? [];
    return levels.map((l) => {
      const sku = skuById.get(l.skuId);
      const name = sku ? productName({ names: sku.names }) : l.skuId.slice(0, 8);
      const unit = sku?.unit ?? '';
      const onHandNum = Number(l.onHand);
      return {
        skuId: l.skuId,
        name,
        unit,
        onHand: l.onHand,
        onHandNum,
        lastMovementAt: l.lastMovementAt,
      };
    });
  }, [levelsQuery.data, skuById, productName]);

  return (
    <div className="px-4 py-3">
      {levelsQuery.isLoading ? (
        <div className="py-6 text-center">
          <Spinner size={16} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={i18n.t('inventory.empty.title')}
          description={i18n.t('inventory.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-1" role="list">
          {rows
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => {
              const stockedOut = r.onHandNum <= 0;
              return (
                <li
                  key={r.skuId}
                  className={
                    'rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline ' +
                    (stockedOut ? 'opacity-70' : '')
                  }
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-old-body font-semibold">{r.name}</span>
                    <span className="font-mono text-old-body tabular-nums">
                      {formatQty(r.onHand)} {unitLabel(r.unit)}
                    </span>
                  </div>
                  {/* M3.17 (2026-05-16): inline pill buttons → Button
                      size="sm" with pearl + danger-ghost variants.
                      Stocktake is a neutral edit; wastage is a real
                      reduce-stock action so the danger-ghost tone is
                      appropriate (red text, no fill — same level as
                      Archive elsewhere). */}
                  <div className="mt-1 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        setAction({
                          kind: 'stocktake',
                          skuId: r.skuId,
                          current: r.onHand,
                        })
                      }
                    >
                      {i18n.t('inventory.action.stocktake')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => setAction({ kind: 'wastage', skuId: r.skuId })}
                    >
                      {i18n.t('inventory.action.wastage')}
                    </Button>
                  </div>
                </li>
              );
            })}
        </ul>
      )}

      {/* Stocktake / wastage editor sheet. */}
      <Sheet
        open={action !== null}
        onOpenChange={(open) => !open && setAction(null)}
        title={
          action?.kind === 'stocktake'
            ? i18n.t('inventory.sheet.stocktake.title')
            : i18n.t('inventory.sheet.wastage.title')
        }
        description={action ? productName({ names: skuById.get(action.skuId)?.names ?? {} }) : ''}
        footer={
          // 2026-07-30: dropped `!getTg() &&` — same defect as the dish
          // editor. `getTg()` is truthy in any browser (the Telegram SDK
          // is a static script tag), and nothing drives the native
          // MainButton for this sheet, so stocktake / wastage had no
          // submit button in any environment. See the CatalogSections
          // dish-editor footer for the full write-up.
          action ? (
            <Button
              block
              loading={stocktake.isPending || recordWastage.isPending}
              onClick={() => {
                if (!action) return;
                if (action.kind === 'stocktake') {
                  stocktake.mutate({
                    storeId,
                    skuId: action.skuId,
                    target: draftTarget,
                    note: draftNote.trim() || undefined,
                  });
                } else {
                  if (!draftNote.trim()) {
                    errToast('common.error')(new Error('inventory.errors.wastageNeedsNote'));
                    return;
                  }
                  recordWastage.mutate({
                    storeId,
                    skuId: action.skuId,
                    qty: draftWasteQty,
                    note: draftNote.trim(),
                  });
                }
              }}
            >
              {i18n.t('common.save')}
            </Button>
          ) : null
        }
      >
        {action ? (
          <div className="flex flex-col gap-3 py-3">
            {action.kind === 'stocktake' ? (
              <>
                <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('inventory.sheet.stocktake.systemSays', {
                    qty: formatQty(action.current),
                  })}
                </div>
                <Field
                  label={i18n.t('inventory.sheet.stocktake.targetLabel')}
                  hint={i18n.t('inventory.sheet.stocktake.targetHint')}
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={skuById.get(action.skuId)?.step ?? '0.1'}
                    min="0"
                    value={draftTarget}
                    onChange={(e) => setDraftTarget(e.target.value)}
                    autoFocus
                  />
                </Field>
                <Field label={i18n.t('inventory.sheet.note')}>
                  <Input
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder={i18n.t('inventory.sheet.stocktake.notePlaceholder')}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={i18n.t('inventory.sheet.wastage.qtyLabel')}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={skuById.get(action.skuId)?.step ?? '0.1'}
                    min="0"
                    value={draftWasteQty}
                    onChange={(e) => setDraftWasteQty(e.target.value)}
                    autoFocus
                  />
                </Field>
                <Field
                  label={i18n.t('inventory.sheet.note')}
                  hint={i18n.t('inventory.sheet.wastage.noteHint')}
                >
                  <Input
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder={i18n.t('inventory.sheet.wastage.notePlaceholder')}
                  />
                </Field>
              </>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

/**
 * StoreSalesTab (M2.0c, 2026-05-08).
 *
 * Sales recording surface for a single store. Closes the ERP loop —
 * each sale auto-deducts ingredient inventory via the dish's recipe
 * BOM (server-side, same transaction). Two zones:
 *
 *   - Today's list (top): every sale recorded today, newest first,
 *     showing time + dish + qty + line revenue if priced.
 *   - "Record sale" entry (bottom): dish picker + qty input. Tap
 *     Save → tRPC roundtrip, list refreshes.
 *
 * Permissions:
 *   - `sales.record` (per-store) for the Save action. Granted by
 *     default to manager + staff roles.
 *   - Anyone with read access to the store can see the list.
 */
function StoreSalesTab({ storeId }: { storeId: string }) {
  const dateFmt = useDateFormat();
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const utils = trpc.useUtils();
  const session = useAuthStore((s) => s.session);
  const canRecord =
    (session?.permissions.includes('sales.record') ?? false) ||
    (session?.permissions.includes('users.manage') ?? false);

  const dishesQuery = trpc.dishes.list.useQuery({ includeArchived: false });
  const salesQuery = trpc.sales.list.useQuery({ storeId });

  const dishById = useMemo(() => {
    const m = new Map<
      string,
      {
        id: string;
        names: Record<string, string>;
        unitPrice: string | null;
        ingredientCount: number;
      }
    >();
    const ingCount = new Map<string, number>();
    for (const ing of dishesQuery.data?.ingredients ?? []) {
      ingCount.set(ing.dishId, (ingCount.get(ing.dishId) ?? 0) + 1);
    }
    for (const d of dishesQuery.data?.dishes ?? []) {
      m.set(d.id, {
        id: d.id,
        names: d.names as Record<string, string>,
        unitPrice: d.unitPrice,
        ingredientCount: ingCount.get(d.id) ?? 0,
      });
    }
    return m;
  }, [dishesQuery.data]);

  const [draftDishId, setDraftDishId] = useState('');
  const [draftQty, setDraftQty] = useState('1');

  const record = trpc.sales.record.useMutation({
    onSuccess: () => {
      void utils.sales.list.invalidate({ storeId });
      // M2.0c: also invalidate inventory levels — consumption rows
      // just landed in the ledger.
      void utils.inventory.levels.invalidate({ storeId });
      toast.success(i18n.t('sales.toast.recorded'));
      setDraftDishId('');
      setDraftQty('1');
    },
    onError: errToast('common.error'),
  });

  const sales = salesQuery.data ?? [];

  // Compute today's headline (revenue + count) for the summary row.
  const summary = useMemo(() => {
    let count = 0;
    let revenue = 0;
    for (const s2 of sales) {
      const qty = Number(s2.qty);
      count += qty;
      if (s2.unitPrice) revenue += qty * Number(s2.unitPrice);
    }
    return { count, revenue };
  }, [sales]);

  // Sort dishes alphabetically for the picker.
  const dishOptions = useMemo(() => {
    const list = [...dishById.values()];
    return list.sort((a, b) =>
      productName({ names: a.names }).localeCompare(productName({ names: b.names })),
    );
  }, [dishById, productName]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {/* Today summary tile. */}
      <div className="grid grid-cols-2 gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
        <div>
          <SectionLabel padded={false}>{i18n.t('sales.summary.today')}</SectionLabel>
          <div className="font-mono text-old-h2 font-semibold tabular-nums">
            {formatQty(summary.count.toString())}
          </div>
          <div className="text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('sales.summary.servings')}
          </div>
        </div>
        <div>
          <SectionLabel padded={false}>{i18n.t('sales.summary.revenue')}</SectionLabel>
          <div className="font-mono text-old-h2 font-semibold tabular-nums">
            {formatMoney(summary.revenue)}
          </div>
          <div className="text-old-label text-[var(--c-fg-muted)]">
            {session?.member.currency ?? 'UZS'}
          </div>
        </div>
      </div>

      {/* Record sale form. */}
      {canRecord ? (
        <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
          {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
          <SectionLabel className="px-0 py-0">{i18n.t('sales.form.recordTitle')}</SectionLabel>
          {dishOptions.length === 0 ? (
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('sales.form.noDishesYet')}
            </p>
          ) : (
            <>
              <select
                className="h-10 w-full rounded-[var(--r-pill)] bg-[var(--c-surface)] px-3 text-old-body ring-hairline"
                value={draftDishId}
                onChange={(e) => setDraftDishId(e.target.value)}
              >
                <option value="">{i18n.t('sales.form.pickDish')}</option>
                {dishOptions.map((d) => {
                  const label = productName({ names: d.names });
                  const suffix =
                    d.ingredientCount === 0 ? ` (${i18n.t('sales.form.noRecipe')})` : '';
                  return (
                    <option key={d.id} value={d.id} disabled={d.ingredientCount === 0}>
                      {label}
                      {suffix}
                    </option>
                  );
                })}
              </select>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="1"
                  min="1"
                  value={draftQty}
                  onChange={(e) => setDraftQty(e.target.value)}
                  aria-label={i18n.t('sales.form.qtyLabel')}
                  className="flex-1"
                />
                <Button
                  loading={record.isPending}
                  disabled={!draftDishId || Number(draftQty) <= 0}
                  onClick={() => {
                    if (!draftDishId || Number(draftQty) <= 0) return;
                    record.mutate({
                      storeId,
                      dishId: draftDishId,
                      qty: Number(draftQty).toFixed(2),
                    });
                  }}
                >
                  {i18n.t('sales.form.recordBtn')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* Today's sales list. */}
      <div>
        {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
        <SectionLabel className="mb-2 px-0">{i18n.t('sales.list.title')}</SectionLabel>
        {salesQuery.isLoading ? (
          <div className="py-4 text-center">
            <Spinner size={16} />
          </div>
        ) : sales.length === 0 ? (
          <EmptyState
            title={i18n.t('sales.empty.title')}
            description={i18n.t('sales.empty.description')}
          />
        ) : (
          <ul className="flex flex-col gap-1" role="list">
            {sales.map((sale) => {
              const dish = dishById.get(sale.dishId);
              const name = dish ? productName({ names: dish.names }) : sale.dishId.slice(0, 8);
              // 2026-07-30: `undefined` meant "browser locale".
              const time = dateFmt.time(sale.occurredAt);
              const lineTotal =
                sale.unitPrice && Number(sale.qty) > 0
                  ? Number(sale.qty) * Number(sale.unitPrice)
                  : null;
              return (
                <li
                  key={sale.id}
                  className="flex items-baseline justify-between gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
                        {time}
                      </span>
                      <span className="truncate text-old-body font-medium">{name}</span>
                    </div>
                    {lineTotal !== null ? (
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × {formatMoney(sale.unitPrice)} ={' '}
                        <span className="font-mono tabular-nums text-[var(--c-fg)]">
                          {formatMoney(lineTotal)}
                        </span>
                      </div>
                    ) : (
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × —
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
