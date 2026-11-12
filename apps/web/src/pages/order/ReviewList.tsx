import { useMemo, useRef } from 'react';
import { cn, EmptyState, NameCell, QtyControl, SectionLabel, surfaceClass } from '@compass/ui';
import { groupCatalog } from './catalogGroups';
import { submittedDiff } from './submittedDiff';
import { useI18n, useProductNameParts, useUnitLabel } from '../../hooks/useI18n';
import { useCurrency } from '../../hooks/useCurrency';
import { useOrderEstimate } from '../../hooks/useOrderEstimate';
import { formatQty, formatMoney } from '../../lib/format';
import { useStoreContext } from '../../hooks/useStoreContext';
import { ORDER_QTY_MAX } from '@compass/contracts/limits';

export interface ReviewTotal {
  skuId: string;
  qty: string;
}

export function ReviewList({
  totals,
  skus,
  categories,
  productName,
  edit,
  submitted,
}: {
  totals: ReviewTotal[];
  skus: Array<{
    id: string;
    categoryId: string | null;
    code: string | null;
    sortIndex?: number | null;
    names: Record<string, string>;
    unit: string;
    step: string;
    isArchived?: boolean;
  }>;
  /** DX-ORD-12: names and order of the category headings. */
  categories: ReadonlyArray<{
    id: string;
    names?: Record<string, string>;
    sortIndex?: number | null;
  }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  /** 2026-11-05: the review before Submit is editable — each line gets the
   *  same qty control as the list (it sets the viewer's own share, like the
   *  list does). Omitted on read-only receipts. */
  edit?: {
    myQtyBySku: ReadonlyMap<string, number>;
    onQtyChange: (skuId: string, qty: string) => void;
  };
  /** 2026-11-05: the order as submitted. On a receipt, lines review changed
   *  show the submitted amount struck through; removed lines stay, struck. */
  submitted?: ReadonlyArray<{ skuId: string; qty: string }> | null;
}) {
  const diff = useMemo(() => submittedDiff(submitted, totals), [submitted, totals]);
  const i18n = useI18n();
  // UI-4: each line's name on two lines; `productName` is for one-line text.
  const productNameParts = useProductNameParts();
  // Lines stepped down to 0 stay in place (at 0) while the sheet is open, so
  // a mis-tap can be undone with + instead of the row jumping out of view.
  const seenRef = useRef(new Set<string>());
  // 2026-07-30 (flow review): was printing the raw canonical unit, so the
  // last screen before Submit read "0.5 kg" while Approval showed "0.5 公斤".
  const unitLabel = useUnitLabel();
  // M1.21: org-wide currency for the estimate suffix.
  const currency = useCurrency();
  // An estimated total (added 2026-05-05), at each product's last price
  // paid; a product never bought yet is left out and counted as unpriced.
  // D6 / RE-SHL-3 (2026-10-31): priced for the store being ordered for —
  // a member who manages another store but is staff here gets no estimate.
  const reviewStoreCtx = useStoreContext();
  const reviewStoreId = reviewStoreCtx.kind === 'specific' ? reviewStoreCtx.storeId : undefined;
  const { estimate } = useOrderEstimate(totals, reviewStoreId);
  // Show the AGGREGATE qty per SKU (sum across all contributors). Group
  // by category. Items without a known SKU fall under "Other".
  const skuById = useMemo(() => {
    const m = new Map<string, (typeof skus)[number]>();
    for (const s of skus) m.set(s.id, s);
    return m;
  }, [skus]);

  // DX-ORD-12 (2026-11-01): grouped by category in the catalog's order,
  // each group under its category name. The cards used to have no
  // heading, so they looked grouped at random.
  const groups = useMemo(() => {
    const lines: Array<(typeof skus)[number] & { qty: string }> = [];
    const byId = new Map(totals.map((t) => [t.skuId, t.qty] as const));
    if (edit) for (const t of totals) if (Number(t.qty) > 0) seenRef.current.add(t.skuId);
    const ids = edit
      ? [...seenRef.current]
      : [
          ...totals.filter((t) => Number(t.qty) > 0).map((t) => t.skuId),
          ...[...diff].filter(([, c]) => c.kind === 'removed').map(([id]) => id),
        ];
    for (const id of ids) {
      const sku = skuById.get(id);
      if (sku) lines.push({ ...sku, qty: byId.get(id) ?? '0' });
    }
    return groupCatalog(lines, categories).map((g) => ({
      key: g.key,
      heading: g.categoryId
        ? productName({
            names: categories.find((c) => c.id === g.categoryId)?.names,
          })
        : i18n.t('order.categories.uncategorized'),
      rows: g.skus.map((sku) => ({
        skuId: sku.id,
        name: productName({ names: sku.names }),
        nameParts: productNameParts({ names: sku.names }),
        qty: sku.qty,
        unit: sku.unit,
        step: sku.step,
        archived: !!sku.isArchived,
      })),
    }));
  }, [totals, skuById, categories, productName, productNameParts, i18n, edit, diff]);

  if (groups.length === 0) {
    return <EmptyState compact title={i18n.t('order.review.empty')} />;
  }
  return (
    <div className="flex flex-col gap-3 py-3">
      {/* Estimated cost — shown when any product has a price to go by
          (the last one paid). Products without one are left out of the
          total and counted, so the staff knows the figure is partial.
          (Added 2026-05-05.) */}
      {/* Review ORD-22 (2026-11): a card, as content is; grey is for
          inputs (UI-13). */}
      {estimate.known > 0 ? (
        <div className={cn(surfaceClass, 'px-4 py-2.5')}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-old-body font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('order.review.estimatedTotal')}
            </span>
            <span className="text-old-h2 font-semibold tabular-nums text-[var(--c-fg)]">
              ~{formatMoney(estimate.total, currency)}
            </span>
          </div>
          <div className="mt-1 text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('order.review.estimateHint', {
              known: estimate.known,
              unknown: estimate.unknown,
            })}
          </div>
        </div>
      ) : null}
      {diff.size > 0 ? (
        <p className="text-old-label text-[var(--c-warning-fg)]" data-testid="order-review-changed">
          {i18n.t('order.submitted.summary')}
        </p>
      ) : null}
      <div className={surfaceClass}>
        {groups.map((g) => (
          <section key={g.key} className="border-b border-[var(--c-divider)] last:border-b-0">
            <SectionLabel as="h3" className="pt-2.5">
              {g.heading}
            </SectionLabel>
            <ul className="flex flex-col" role="list">
              {g.rows.map((r) => {
                const myQty = edit?.myQtyBySku.get(r.skuId) ?? 0;
                const total = Number(r.qty);
                const others = total - myQty;
                if (edit) {
                  const dropped = !(myQty > 0 || others > 0);
                  return (
                    <li
                      key={r.skuId}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--c-divider)] px-4 py-2 first:border-t-0"
                    >
                      {/* Walkthrough F4 (2026-11-05): a line taken to 0 dimmed
                          the whole row, + included, so it looked as if it
                          could not be added back. Only the name dims now. */}
                      <div className="min-w-[7rem] flex-1">
                        <NameCell
                          {...r.nameParts}
                          size="prominent"
                          className={dropped ? 'text-[var(--c-fg-muted)] line-through' : undefined}
                          primaryClassName={cn(
                            'line-clamp-none',
                            dropped && 'text-[var(--c-fg-muted)]',
                          )}
                        />
                        {r.archived ? (
                          <div className="text-old-label text-[var(--c-warning-fg)]">
                            {i18n.t('order.review.archived')}
                          </div>
                        ) : null}
                        {others > 0 ? (
                          <div className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
                            {i18n.t('order.totalQty', {
                              qty: formatQty(total),
                              unit: unitLabel(r.unit, total),
                            })}
                          </div>
                        ) : null}
                      </div>
                      <QtyControl
                        value={myQty}
                        step={Number(r.step)}
                        unit={unitLabel.uncounted(r.unit)}
                        unitFor={(q) => unitLabel(r.unit, q)}
                        max={r.archived ? myQty : ORDER_QTY_MAX}
                        pickTitle={r.name}
                        onChange={(next) => edit.onQtyChange(r.skuId, String(next))}
                        className="ml-auto"
                      />
                    </li>
                  );
                }
                const ch = diff.get(r.skuId);
                return (
                  <li
                    key={r.skuId}
                    data-change={ch?.kind}
                    className="flex items-start justify-between gap-3 border-t border-[var(--c-divider)] px-4 py-2.5 first:border-t-0"
                  >
                    {/* 2026-07-05: match the prominent SKU-name tier used
                      by SkuRow above (the Order surface is the "browse"
                      tier, text-old-h2) so the review summary and the pick
                      list read at the same size. 2026-11-05: names wrap
                      instead of being cut off on a narrow phone. */}
                    <div className="min-w-0 flex-1">
                      <NameCell
                        {...r.nameParts}
                        size="prominent"
                        className={
                          ch?.kind === 'removed'
                            ? 'text-[var(--c-fg-muted)] line-through'
                            : undefined
                        }
                        primaryClassName={cn(
                          'line-clamp-none',
                          ch?.kind === 'removed' && 'text-[var(--c-fg-muted)]',
                        )}
                      />
                      {r.archived ? (
                        <div className="text-old-label text-[var(--c-warning-fg)]">
                          {i18n.t('order.review.archived')}
                        </div>
                      ) : null}
                      {ch?.kind === 'added' || ch?.kind === 'removed' ? (
                        <div className="text-old-label font-semibold text-[var(--c-warning-fg)]">
                          {i18n.t(
                            ch.kind === 'added'
                              ? 'order.submitted.added'
                              : 'order.submitted.removed',
                          )}
                        </div>
                      ) : null}
                    </div>
                    <span className="shrink-0 pt-0.5 text-old-body tabular-nums text-[var(--c-fg-muted)]">
                      {ch?.kind === 'changed' ? (
                        <>
                          <s className="mr-1.5">{formatQty(ch.before)}</s>
                          <span className="font-semibold text-[var(--c-fg)]">
                            {formatQty(r.qty)}
                          </span>{' '}
                          {unitLabel(r.unit, r.qty)}
                        </>
                      ) : ch?.kind === 'removed' ? (
                        <s>
                          {formatQty(ch.before)} {unitLabel(r.unit, ch.before)}
                        </s>
                      ) : (
                        <>
                          {formatQty(r.qty)} {unitLabel(r.unit, r.qty)}
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
