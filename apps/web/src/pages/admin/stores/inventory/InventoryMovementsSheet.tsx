/**
 * Store → Inventory: the last 50 stock movements of one product, opened
 * by tapping its row (2026-10-21). Review ADM2-11 (2026-11-11): its own
 * component; it lived inside StoreInventoryTab.
 */
import {
  EmptyState,
  LoadingState,
  OfflineState,
  QueryErrorBanner,
  Sheet,
  isWaitingOffline,
  rowGroupClass,
} from '@compass/ui';
import type { MovementReason } from '@compass/contracts/limits';
import { trpc } from '../../../../lib/trpc';
import { formatQty } from '../../../../lib/format';
import { useDateFormat, useI18n, useUnitLabel } from '../../../../hooks/useI18n';
import { knownMovementReason, signedDelta } from '../inventoryHelpers';

/** 2026-10-21: localized label per ledger reason. */
const MOVEMENT_REASON_LABEL = {
  delivery_received: 'inventory.reason.delivery_received',
  stocktake: 'inventory.reason.stocktake',
  wastage: 'inventory.reason.wastage',
  consumption: 'inventory.reason.consumption',
  consumption_reversed: 'inventory.reason.consumption_reversed',
  transfer_in: 'inventory.reason.transfer_in',
  transfer_out: 'inventory.reason.transfer_out',
  adjustment: 'inventory.reason.adjustment',
} as const satisfies Record<MovementReason, string>;

export function InventoryMovementsSheet({
  storeId,
  item,
  unit,
  onClose,
}: {
  storeId: string;
  /** The product whose movements show; null keeps the sheet closed. */
  item: { skuId: string; name: string } | null;
  /** The product's unit, for the quantities. */
  unit: string;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const dateFmt = useDateFormat();
  const movementsQuery = trpc.inventory.recentMovements.useQuery(
    { storeId, skuId: item?.skuId ?? '' },
    { enabled: item !== null },
  );

  return (
    <Sheet
      open={item !== null}
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t('inventory.movements.title')}
      description={item?.name ?? ''}
    >
      {item ? (
        <div className="py-3">
          {movementsQuery.isLoading ? (
            <LoadingState variant="compact" />
          ) : isWaitingOffline(movementsQuery) ? (
            <OfflineState />
          ) : movementsQuery.isError ? (
            <QueryErrorBanner query={movementsQuery} />
          ) : (movementsQuery.data ?? []).length === 0 ? (
            <EmptyState title={i18n.t('inventory.movements.empty')} />
          ) : (
            // Review ADM2-12 (2026-11-11): rows of one white card, not grey
            // cards (UI-6, UI-13).
            <ul className={rowGroupClass} role="list">
              {(movementsQuery.data ?? []).map((m) => {
                const known = knownMovementReason(m.reason);
                const { sign, abs } = signedDelta(m.delta);
                return (
                  <li key={m.id} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-old-body font-medium">
                        {/* Review ADM2-42: a reason this build does not know reads
                            "other", not its raw code. */}
                        {i18n.t(known ? MOVEMENT_REASON_LABEL[known] : 'inventory.reason.other')}
                      </span>
                      <span
                        className={
                          'text-old-body tabular-nums ' +
                          (sign === '-' ? 'text-[var(--c-danger)]' : '')
                        }
                      >
                        {sign}
                        {formatQty(abs)} {unitLabel(unit, abs)}
                      </span>
                    </div>
                    <div className="text-old-label text-[var(--c-fg-muted)]">
                      {dateFmt.dateTime(m.occurredAt)}
                      {m.actorName ? ` · ${m.actorName}` : ''}
                      {m.note ? ` · ${m.note}` : ''}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
