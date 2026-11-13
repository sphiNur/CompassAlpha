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
 * the row tap (opens a sheet listing the last 50 movements) — wired
 * 2026-10-21; the comment promised it long before the UI had it.
 *
 * 2026-10-21: "Add stocktake for another SKU" posts an opening count
 * for an active SKU with no ledger row here yet (a new store had no way
 * to start its inventory except waiting for a delivery).
 *
 * Review ADM2-11 (2026-11-11): the stocktake/wastage sheet and the
 * movements sheet are components of their own (InventoryActionSheet,
 * InventoryMovementsSheet); with the list they were one function of
 * about 550 lines.
 *
 * D1 (2026-11-13): "Count stock" opens the count mode (StockCountSheet),
 * every product of the store on one screen with one Save. A row's
 * Stocktake stays for a single correction.
 */
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingState,
  NameCell,
  OfflineState,
  QueryErrorBanner,
  cn,
  isWaitingOffline,
  rowGroupClass,
} from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { formatQty } from '../../../../lib/format';
import {
  useI18n,
  useProductName,
  useProductNameParts,
  useUnitLabel,
} from '../../../../hooks/useI18n';
import { rowName } from '../../../../lib/productName';
import { skusWithoutLevel, sortLevelRows } from '../inventoryHelpers';
import {
  InventoryActionSheet,
  type InventoryAction,
  type InventorySku,
} from './InventoryActionSheet';
import { InventoryMovementsSheet } from './InventoryMovementsSheet';
import { StockCountSheet } from './StockCountSheet';
import { hasStorePermission } from '../../../../lib/storePermission';

export function StoreInventoryTab({ storeId, storeName }: { storeId: string; storeName?: string }) {
  const i18n = useI18n();
  // 2026-07-30 (flow review): on-hand quantities printed the raw canonical
  // unit while the rest of the app printed the localized label.
  const unitLabel = useUnitLabel();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
  const levelsQuery = trpc.inventory.levels.useQuery({ storeId });
  // Archived products too: stock of a product archived since still has a
  // level row and showed as an 8-character id. Opening counts offer
  // active ones only (skusWithoutLevel).
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  // 2026-10-21 audit CA-16: mirror the server's requireInventoryAdjust
  // exactly — read-only members saw both buttons and got a 403 on save.
  // CA-10/CA-57: the users.manage fallback is gone on both sides
  // (migration 0048 backfilled manager → inventory.adjust).
  const canAdjust = useAuthStore(
    (s) => s.session?.permissions.includes('inventory.adjust') ?? false,
  );
  // D1: the count mode asks this store's permissions (store overrides
  // included), as the server's stocktakeBatch does.
  const canCount = useAuthStore((s) => hasStorePermission(s.session, storeId, 'inventory.adjust'));
  const [counting, setCounting] = useState(false);

  const skuById = useMemo(() => {
    const m = new Map<string, InventorySku>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names,
        unit: sku.unit,
        step: sku.step,
        isArchived: sku.isArchived,
      });
    }
    return m;
  }, [skusQuery.data]);

  const [action, setAction] = useState<InventoryAction | null>(null);
  // 2026-10-21: movements drill-down for one level row.
  const [movementsFor, setMovementsFor] = useState<{ skuId: string; name: string } | null>(null);

  const rows = useMemo(() => {
    const levels = levelsQuery.data ?? [];
    return levels.map((l) => {
      const sku = skuById.get(l.skuId);
      const name = sku ? productName({ names: sku.names }) : i18n.t('common.unknownProduct');
      const unit = sku?.unit ?? '';
      const onHandNum = Number(l.onHand);
      return {
        skuId: l.skuId,
        // One line for the movements sheet's title; two in the row (UI-4).
        name,
        nameParts: rowName(productNameParts, sku, i18n.t('common.unknownProduct')),
        unit,
        onHand: l.onHand,
        onHandNum,
        lastMovementAt: l.lastMovementAt,
      };
    });
  }, [levelsQuery.data, skuById, productName, productNameParts, i18n]);

  // 2026-10-21: active SKUs with no ledger row here — opening-stock picks.
  const openingCandidates = useMemo(
    () =>
      skusWithoutLevel([...skuById.values()], levelsQuery.data ?? [])
        .map((sku) => ({ id: sku.id, name: productName({ names: sku.names }) }))
        // Review ADM2-37 (2026-11-11): in the interface language, like the
        // level rows (DX-INV-3); with no locale Chinese sorted by code point.
        .sort((a, b) => a.name.localeCompare(b.name, i18n.locale)),
    [skuById, levelsQuery.data, productName, i18n.locale],
  );

  return (
    <div className="px-4 py-3">
      {canCount || (canAdjust && levelsQuery.isSuccess && openingCandidates.length > 0) ? (
        <div className="mb-3 flex flex-wrap justify-end gap-x-2 gap-y-3">
          {canAdjust && levelsQuery.isSuccess && openingCandidates.length > 0 ? (
            <Button
              size="sm"
              variant="pearl"
              onClick={() =>
                setAction({ kind: 'stocktake', skuId: '', current: '0', pickSku: true })
              }
            >
              {i18n.t('inventory.action.addStocktake')}
            </Button>
          ) : null}
          {canCount ? (
            <Button size="sm" onClick={() => setCounting(true)}>
              {i18n.t('inventory.count.title')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {levelsQuery.isLoading ? (
        <LoadingState variant="compact" />
      ) : isWaitingOffline(levelsQuery) ? (
        // R2-ENG-1 (2026-10-31): offline with no saved copy is not "no stock".
        <OfflineState />
      ) : levelsQuery.isError ? (
        // CLS-1 (2026-10-30): a failed load used to read "no stock data
        // yet", with the opening-stock button still offered above it.
        <QueryErrorBanner query={levelsQuery} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={i18n.t('inventory.empty.title')}
          description={i18n.t('inventory.empty.description')}
        />
      ) : (
        // Review ADM2-12 (2026-11-11): rows of one card (UI-6), not a card each.
        <ul className={rowGroupClass} role="list">
          {sortLevelRows(rows, i18n.locale).map((r) => {
            // DX-INV-3 (2026-11-01): negative stock stands out instead of
            // fading — the whole row was at 70 % opacity, so the item
            // that most needed a count was the hardest to see. Zero is
            // shown plainly; negative gets a red edge and a badge.
            const negative = r.onHandNum < 0;
            return (
              <li
                key={r.skuId}
                className={cn(
                  'px-4 py-2.5',
                  negative && 'ring-1 ring-inset ring-[var(--c-danger)]',
                )}
              >
                {/* 2026-10-21: tap → recent movements sheet. */}
                <button
                  type="button"
                  className="hit-44 flex w-full items-baseline justify-between gap-2 text-left active:opacity-80"
                  onClick={() => setMovementsFor({ skuId: r.skuId, name: r.name })}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <NameCell as="span" {...r.nameParts} />
                    {negative ? (
                      <Badge tone="danger" className="shrink-0 whitespace-nowrap">
                        {i18n.t('inventory.badge.negative')}
                      </Badge>
                    ) : null}
                  </span>
                  <span
                    className={
                      'shrink-0 text-old-body tabular-nums ' +
                      (negative ? 'font-semibold text-[var(--c-danger-ink)]' : '')
                    }
                  >
                    {formatQty(r.onHand)} {unitLabel(r.unit, r.onHand)}
                  </span>
                </button>
                {/* M3.17 (2026-05-16): inline pill buttons → Button
                    size="sm" with pearl + danger-ghost variants.
                    Stocktake is a neutral edit; wastage is a real
                    reduce-stock action so the danger-ghost tone is
                    appropriate (red text, no fill — same level as
                    Archive elsewhere). */}
                {canAdjust ? (
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
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <InventoryActionSheet
        storeId={storeId}
        action={action}
        onActionChange={setAction}
        skuById={skuById}
        openingCandidates={openingCandidates}
        onHand={(skuId) => (levelsQuery.data ?? []).find((l) => l.skuId === skuId)?.onHand ?? '0'}
      />
      <StockCountSheet
        storeId={storeId}
        storeName={storeName}
        open={counting}
        onClose={() => setCounting(false)}
      />
      <InventoryMovementsSheet
        storeId={storeId}
        item={movementsFor}
        unit={movementsFor ? (skuById.get(movementsFor.skuId)?.unit ?? '') : ''}
        onClose={() => setMovementsFor(null)}
      />
    </div>
  );
}
