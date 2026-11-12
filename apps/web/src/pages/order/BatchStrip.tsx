import { cn, rowGroupClass, SectionLabel } from '@compass/ui';
import { sentBatchCount } from './batchCount';
import { useI18n } from '../../hooks/useI18n';
import { formatMoney } from '../../lib/format';
import { orderStatusLabel } from '../../lib/statusLabels/order';

/**
 * "Today's batches" strip (2026-07-30).
 *
 * M3.32 gave a (member, store, day) several sessions; the Order page only
 * ever showed one of them, so submitting a batch and starting another made
 * the first disappear with no trace. This is the trace: one chip per batch,
 * the one you're looking at marked, so "did my morning order go through?"
 * is answerable without leaving the page.
 *
 * Renders nothing for a single batch — with one chip the strip would just
 * restate the receipt below it.
 */
export function BatchStrip({
  batches,
  currentId,
  i18n,
  currency,
  showHeading = true,
  onSelect,
}: {
  /** ORD-4 (2026-10-30): a row opens that batch. */
  onSelect?: (id: string) => void;
  /** The sheet that can host this strip supplies its own title, so it
   *  turns the internal heading off rather than stating "今日 N 批" twice. */
  showHeading?: boolean;
  batches: Array<{
    id: string;
    status: string;
    batchNumber: number;
    itemCount: number;
    estimatedTotal: string | null;
    extrasCount: number;
  }>;
  currentId: string;
  i18n: ReturnType<typeof useI18n>;
  currency: string;
}) {
  if (batches.length < 2) return null;
  return (
    <div>
      {showHeading ? (
        <SectionLabel padded={false} className="mb-1.5">
          {i18n.t('order.batches.today', { n: sentBatchCount(batches) })}
        </SectionLabel>
      ) : null}
      {/* Review ORD-22 (2026-11): one card of rows divided by hairlines (UI-6,
          UI-13); each batch was a grey card of its own. The one shown is
          tinted. */}
      <ul className={rowGroupClass} role="list">
        {batches.map((b) => {
          const isCurrent = b.id === currentId;
          return (
            <li key={b.id}>
              <button
                type="button"
                disabled={!onSelect || isCurrent}
                onClick={() => onSelect?.(b.id)}
                className={cn(
                  // V4: min-h-11 — a stacked list row is tapped across its whole height.
                  // ORD-25: wraps, so the counts go under the name when both do not fit.
                  'flex min-h-11 w-full flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-3 py-2 text-left text-old-label',
                  onSelect && !isCurrent && 'press',
                  isCurrent && 'bg-[color:color-mix(in_oklch,var(--c-action)_10%,transparent)]',
                )}
              >
                <span className="min-w-0 truncate">
                  <span className="font-semibold text-[var(--c-fg)]">
                    {i18n.t('order.batches.batchLabel', { n: b.batchNumber })}
                  </span>{' '}
                  <span className="text-[var(--c-fg-muted)]">
                    {/* ORD-18 (2026-10-30): a rejected batch reads "Rejected"
                      alone; the strip has no reason to follow it. */}
                    {orderStatusLabel(i18n, b.status)}
                  </span>
                  {isCurrent ? (
                    <span className="text-[var(--c-action)]">
                      {' · '}
                      {i18n.t('order.batches.viewing')}
                    </span>
                  ) : null}
                </span>
                {/* Review ORD-25 (2026-11): this part kept to one line and
                    would not shrink, so on a narrow phone in Russian or
                    Uzbek it squeezed the batch's name to nothing or ran
                    off the row. It moves under the name and may wrap. */}
                <span className="ml-auto tabular-nums text-[var(--c-fg-muted)]">
                  {/* ORD-20: the "+" is the catalog's. */}
                  {b.extrasCount > 0
                    ? i18n.t('order.batches.itemsAndExtras', {
                        items: i18n.t('approval.itemsCount', { n: b.itemCount }),
                        extras: i18n.t('order.batches.extras', { n: b.extrasCount }),
                      })
                    : i18n.t('approval.itemsCount', { n: b.itemCount })}
                  {b.estimatedTotal ? ` · ~${formatMoney(b.estimatedTotal, currency)}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
