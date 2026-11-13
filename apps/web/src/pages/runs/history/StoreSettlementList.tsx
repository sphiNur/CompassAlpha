/**
 * Per-store breakdown of a finished run — the settlement view.
 *
 * M3.52 (2026-05-23): each row is one store's strict slice of the run
 * cost (SKU lines + expense splits, never mixing). Shows item count,
 * cash/transfer split when mixed, and any off-catalog expenses attributed
 * to the store. This is the manager's source of truth for reconciling who
 * owes what after the run finishes.
 */
import { toCents } from '@compass/contracts/money';
import { SectionLabel, surfaceClass } from '@compass/ui';
import { useCurrency } from '../../../hooks/useCurrency';
import { useI18n } from '../../../hooks/useI18n';
import { formatMoney } from '../../../lib/format';
import type { HistoryStoreMoney } from '../lib/historyBreakdown';
import type { StoreLite } from '../types';

export function StoreSettlementList({
  stores,
  storeById,
}: {
  stores: readonly HistoryStoreMoney[];
  storeById: Map<string, StoreLite>;
}) {
  const i18n = useI18n();
  const currency = useCurrency();
  return (
    <div>
      <SectionLabel padded={false} className="mb-2">
        {i18n.t('run.history.storesHeading')}
      </SectionLabel>
      <ul className={`flex flex-col ${surfaceClass}`}>
        {stores.map((ps) => {
          const store = storeById.get(ps.storeId);
          const mixed = toCents(ps.cash) > 0n && toCents(ps.transfer) > 0n;
          return (
            <li
              key={ps.storeId}
              className="flex flex-col gap-1 border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-old-body font-semibold">
                    {store?.name ?? i18n.t('common.unknownStore')}
                  </div>
                  <div className="text-old-label text-[var(--c-fg-muted)]">
                    {/* M3.52 i18n fix: was hardcoded "items" string; now
                        uses the localized plural key shared with the rest
                        of the app. Counts UNIQUE SKUs delivered to this
                        store, not split rows. */}
                    {i18n.t('run.label.itemsCount', {
                      n: ps.itemCount,
                    })}
                    {ps.expenseCount > 0 ? (
                      <>
                        {' · '}
                        {i18n.t('run.confirm.finish.expenses', {
                          n: ps.expenseCount,
                          total: formatMoney(ps.expensesTotal),
                          currency,
                        })}
                      </>
                    ) : null}
                  </div>
                </div>
                <span className="text-old-body font-semibold tabular-nums">
                  {formatMoney(ps.total)}
                </span>
              </div>
              {mixed ? (
                <div className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
                  {i18n.t('run.money.cashTransfer', {
                    cash: formatMoney(ps.cash),
                    transfer: formatMoney(ps.transfer),
                  })}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
