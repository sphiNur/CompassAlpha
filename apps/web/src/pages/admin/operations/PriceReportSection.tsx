/**
 * Admin → Operations → Price report. Review ADM2-10 (2026-11-11): one
 * file per Operations section.
 */
import { useMemo } from 'react';
import {
  Badge,
  Banner,
  DataState,
  EmptyState,
  LoadingState,
  NameCell,
  cn,
  rowGroupClass,
} from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { formatMoney } from '../../../lib/format';
import { useI18n, useProductNameParts, useUnitLabel } from '../../../hooks/useI18n';
import { rowName } from '../../../lib/productName';

/**
 * Price report (added 2026-05-05).
 *
 * Per-SKU table:
 *   - last price seen (with date)
 *   - 7-day mean
 *   - 30-day mean
 *   - delta (last vs 30-day mean) so admin can spot outliers
 *
 * Reads `catalog.skuPriceStats` once for ALL SKUs in the org (no
 * skuIds filter) plus `catalog.skus` for names. Sort: highest 30d mean
 * first — most expensive items are usually the ones the user cares
 * about budgeting.
 *
 * Why this exists: the user wants "use yesterday's prices to budget
 * for tomorrow's purchase". The OrderPage review sheet now uses
 * 7-day avg automatically (downstream of the same endpoint), but
 * admins also want a standalone view to spot anomalies and trends.
 */
export function PriceReportSection() {
  const i18n = useI18n();
  const productNameParts = useProductNameParts();
  // 2026-07-30 (flow review): the "/ unit" suffix printed the raw canonical
  // unit next to a localized product name.
  const unitLabel = useUnitLabel();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  // No skuIds filter → return all SKUs with observations in 30 days.
  const statsQuery = trpc.catalog.skuPriceStats.useQuery();

  const skuById = useMemo(() => {
    const m = new Map<string, { id: string; names: Record<string, string>; unit: string }>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names,
        unit: sku.unit,
      });
    }
    return m;
  }, [skusQuery.data]);

  const rows = useMemo(() => {
    const stats = statsQuery.data ?? [];
    return stats
      .map((r) => {
        const sku = skuById.get(r.skuId);
        const nameParts = rowName(productNameParts, sku, i18n.t('common.unknownProduct'));
        const last = r.lastPrice ? Number(r.lastPrice) : null;
        const avg30 = r.avg30d ? Number(r.avg30d) : null;
        // Delta = (last − avg30) / avg30, signed. Used for the trend
        // arrow + tone. Skip when either side is unknown.
        const deltaPct =
          last !== null && avg30 && avg30 > 0 ? ((last - avg30) / avg30) * 100 : null;
        return {
          skuId: r.skuId,
          nameParts,
          unit: sku?.unit ?? '',
          last,
          lastObservedAt: r.lastObservedAt,
          avg7d: r.avg7d ? Number(r.avg7d) : null,
          avg30d: avg30,
          observations: r.observations30d,
          deltaPct,
        };
      })
      .sort((a, b) => (b.avg30d ?? 0) - (a.avg30d ?? 0));
  }, [statsQuery.data, skuById, productNameParts, i18n]);

  return (
    <div className="px-4 py-3">
      <Banner tone="info" title={i18n.t('ops.price.howTitle')}>
        {i18n.t('ops.price.howBody')}
      </Banner>
      {statsQuery.isLoading || skusQuery.isLoading ? (
        <LoadingState variant="compact" />
      ) : statsQuery.isError || skusQuery.isError ? (
        // 2026-10-21 FE-01 (F6-04): a failed query used to fall through
        // to "no price data yet". DataState renders the translated error
        // + Retry; the children branch is unreachable here.
        <div className="mt-3">
          <DataState
            query={{
              data: undefined,
              isLoading: false,
              isError: true,
              isFetching: statsQuery.isFetching || skusQuery.isFetching,
              error: statsQuery.error ?? skusQuery.error,
              refetch: () => {
                if (statsQuery.isError) void statsQuery.refetch();
                if (skusQuery.isError) void skusQuery.refetch();
              },
            }}
          >
            {() => null}
          </DataState>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={i18n.t('ops.price.emptyTitle')}
          description={i18n.t('ops.price.emptyBody')}
        />
      ) : (
        <ul className={cn('mt-3', rowGroupClass)} role="list">
          {rows.map((r) => {
            const tone =
              r.deltaPct === null
                ? 'muted'
                : Math.abs(r.deltaPct) < 5
                  ? 'muted'
                  : r.deltaPct > 0
                    ? 'danger'
                    : 'success';
            const arrow =
              r.deltaPct === null ? '·' : r.deltaPct > 0 ? '▲' : r.deltaPct < 0 ? '▼' : '·';
            const deltaLabel =
              r.deltaPct === null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`;
            return (
              <li key={r.skuId} className="flex flex-col gap-1 px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <NameCell {...r.nameParts} />
                  <span className="shrink-0 text-old-body tabular-nums text-[var(--c-fg)]">
                    {r.last !== null ? formatMoney(r.last) : '—'}{' '}
                    <span className="text-old-label font-normal text-[var(--c-fg-muted)]">
                      / {unitLabel.uncounted(r.unit)}
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-3 text-old-label text-[var(--c-fg-muted)]">
                  <span>
                    {i18n.t('ops.price.avg7d')}{' '}
                    <span className="tabular-nums text-[var(--c-fg)]">
                      {r.avg7d !== null ? formatMoney(r.avg7d) : '—'}
                    </span>
                  </span>
                  <span>
                    {i18n.t('ops.price.avg30d')}{' '}
                    <span className="tabular-nums text-[var(--c-fg)]">
                      {r.avg30d !== null ? formatMoney(r.avg30d) : '—'}
                    </span>
                  </span>
                  <span>{i18n.t('ops.price.observations', { n: r.observations })}</span>
                  <Badge tone={tone}>
                    {arrow} {deltaLabel}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
