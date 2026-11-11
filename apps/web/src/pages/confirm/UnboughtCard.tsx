/**
 * DX-DLV-13 (2026-11-01): what this store ordered on the run that the
 * purchaser did not find, listed as 没买到 so the store knows it is not
 * coming. Review CONF-07: moved out of ConfirmPage.
 */
import { Card, NameCell, SectionLabel } from '@compass/ui';
import { useI18n, useProductNameParts, useUnitLabel } from '../../hooks/useI18n';
import { rowName } from '../../lib/productName';
import { formatQty } from '../../lib/format';

export function UnboughtCard({
  items,
  skuById,
  showHint,
}: {
  items: ReadonlyArray<{ skuId: string; orderedQty: string; unavailableNote?: string | null }>;
  skuById: ReadonlyMap<string, { names: Record<string, string>; unit: string }>;
  /** The page says it in its empty state when nothing else is listed. */
  showHint: boolean;
}) {
  const i18n = useI18n();
  const productNameParts = useProductNameParts();
  const unitLabel = useUnitLabel();
  return (
    <Card data-testid="confirm-unbought">
      <SectionLabel as="h2" meta={String(items.length)}>
        {i18n.t('confirm.unbought.title')}
      </SectionLabel>
      {showHint ? (
        <p className="px-4 pb-2 text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('confirm.unbought.hint')}
        </p>
      ) : null}
      <ul className="flex flex-col" role="list">
        {items.map((it) => {
          const sku = skuById.get(it.skuId);
          return (
            <li
              key={it.skuId}
              className="flex flex-col gap-1 border-t border-[var(--c-divider)] px-4 py-2 text-[var(--c-fg-muted)]"
            >
              <div className="flex items-start justify-between gap-3">
                <NameCell
                  {...rowName(productNameParts, sku, i18n.t('common.unknownProduct'))}
                  size="default"
                />
                <span className="shrink-0 text-old-label tabular-nums">
                  {i18n.t('confirm.unbought.ordered', {
                    qty: formatQty(it.orderedQty),
                    unit: unitLabel(sku?.unit, it.orderedQty),
                  })}
                </span>
              </div>
              {it.unavailableNote ? (
                <div className="text-old-label">
                  {i18n.t('confirm.unbought.reason', { reason: it.unavailableNote })}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
