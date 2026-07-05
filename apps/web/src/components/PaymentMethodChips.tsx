import { cn } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';

/**
 * PaymentMethodChips — the cash / transfer two-chip picker used in the
 * purchase + add-item sheets. Was copy-pasted byte-for-byte at two sites
 * in RunPage (PurchaseSheet, AddItemSheet — the second even commented
 * "mirror PurchaseSheet's shape"). One source now.
 *
 * NOTE: PurchaseRow's inline cash/transfer control is a DIFFERENT
 * affordance (a single icon-only toggle with a ring-accent active state,
 * not a two-chip group) and is intentionally not folded in here.
 *
 * The 💵/🏦 glyphs are preserved as-is for a behaviour-preserving
 * extraction; the UI-1 decision on whether they're redundant next to the
 * text label belongs to the Phase 6 emoji sweep.
 */
export interface PaymentMethodChipsProps {
  value: 'cash' | 'transfer';
  onChange: (method: 'cash' | 'transfer') => void;
  className?: string;
}

export function PaymentMethodChips({ value, onChange, className }: PaymentMethodChipsProps) {
  const i18n = useI18n();
  return (
    <div className={cn('flex gap-2', className)}>
      {(['cash', 'transfer'] as const).map((m) => {
        const selected = value === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className={cn(
              'press flex-1 rounded-[var(--r-pill)] px-3 py-2 text-label font-medium ring-hairline',
              selected
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]',
            )}
          >
            {m === 'cash' ? '💵 ' : '🏦 '}
            {m === 'cash' ? i18n.t('run.label.paymentCash') : i18n.t('run.label.paymentTransfer')}
          </button>
        );
      })}
    </div>
  );
}
