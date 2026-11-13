/**
 * DX-HIS-6 (2026-11-01): a finished run's expenses themselves, not only
 * "n expenses" inside a store's row.
 */
import { EmptyState, SectionLabel, surfaceClass } from '@compass/ui';
import { PhotoThumb, type ViewedPhoto } from '../../../components/PhotoThumb';
import { useI18n, useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney, formatQty } from '../../../lib/format';
import type { HistoryExpense } from '../lib/historyBreakdown';

export function HistoryExpenseList({
  expenses,
  onOpenPhoto,
}: {
  expenses: readonly HistoryExpense[];
  onOpenPhoto: (photo: ViewedPhoto) => void;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  return (
    <div>
      <SectionLabel padded={false} className="mb-2">
        {i18n.t('run.history.expensesHeading')}
      </SectionLabel>
      {/* UX-20 (2026-11-14): the run has expenses, none of them for the
          store chosen above; the heading stood over an empty card. */}
      {expenses.length === 0 ? (
        <div className={surfaceClass}>
          <EmptyState compact title={i18n.t('run.history.noStoreExpenses')} />
        </div>
      ) : (
        <ul className={`flex flex-col ${surfaceClass}`}>
          {expenses.map((ex) => (
            <li
              key={ex.id}
              data-testid="history-expense"
              className="flex flex-col gap-1 border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-old-body font-semibold">{ex.label}</span>
                <span className="text-old-body font-semibold tabular-nums">
                  {ex.unitPrice != null ? formatMoney(ex.amount ?? '0') : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-old-label text-[var(--c-fg-muted)]">
                <span className="min-w-0">
                  {`${formatQty(ex.qty)}${ex.unitHint ? ` ${unitLabel(ex.unitHint, ex.qty)}` : ''}`}
                  {ex.unitPrice != null ? ` × ${formatMoney(ex.unitPrice)}` : ''}
                  {ex.reason ? ` · ${ex.reason}` : ''}
                </span>
                <span className="flex shrink-0 items-center gap-2 font-medium text-[var(--c-fg)]">
                  {i18n.t(
                    ex.paymentMethod === 'transfer'
                      ? 'run.label.paymentTransfer'
                      : 'run.label.paymentCash',
                  )}
                  {ex.receiptPhotoUrl ? (
                    <PhotoThumb
                      url={ex.receiptPhotoUrl}
                      label={i18n.t('run.history.receiptOf', { item: ex.label })}
                      onOpen={onOpenPhoto}
                    />
                  ) : null}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
