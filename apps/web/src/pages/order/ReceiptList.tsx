import { SectionLabel } from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { extrasChanged } from './submittedDiff';
import { useI18n, useUnitLabel } from '../../hooks/useI18n';
import { formatQty } from '../../lib/format';
import { ReviewList, type ReviewTotal } from './ReviewList';

/**
 * A sent order's receipt (2026-11-05): the lines now, compared with the
 * order as submitted once review has touched it, plus the submitted
 * off-catalog items when review changed those.
 */
export function ReceiptList({
  sessionId,
  status,
  totals,
  extras,
  ...rest
}: {
  sessionId: string;
  status: string;
  totals: ReviewTotal[];
  extras: ReadonlyArray<{ name: string; qty: string; unit: string }>;
} & Omit<Parameters<typeof ReviewList>[0], 'totals' | 'edit' | 'submitted'>) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const submitted = trpc.order.submittedVersion.useQuery(
    { sessionId },
    { enabled: sessionId !== 'optimistic' && status !== 'draft', staleTime: 30_000 },
  );
  const snap = submitted.data ?? null;
  return (
    <>
      <ReviewList {...rest} totals={totals} submitted={snap?.totals ?? null} />
      {snap && extrasChanged(snap.extras, extras) ? (
        <div className="mt-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-2.5 ring-hairline">
          <SectionLabel as="h3" padded={false}>
            {i18n.t('order.submitted.extrasOriginal')}
          </SectionLabel>
          {snap.extras.length === 0 ? (
            <p className="mt-1 text-old-body text-[var(--c-fg-muted)]">—</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5" role="list">
              {snap.extras.map((e, i) => (
                <li
                  key={`${e.name}-${i}`}
                  className="flex items-baseline justify-between gap-3 text-old-body"
                >
                  <span className="min-w-0 flex-1 break-words text-[var(--c-fg)]">{e.name}</span>
                  <span className="shrink-0 tabular-nums text-[var(--c-fg-muted)]">
                    {formatQty(e.qty)} {unitLabel(e.unit, e.qty)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
}
