import { cn } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';

/**
 * PaymentMethodChips — the cash / transfer two-chip picker used in the
 * purchase + add-item sheets. Was copy-pasted byte-for-byte at two sites
 * in RunPage (PurchaseSheet, AddItemSheet — the second even commented
 * "mirror PurchaseSheet's shape"). One source now.
 *
 * NOTE: PurchaseRow's inline cash/transfer control is a DIFFERENT
 * affordance (a single toggle in a fixed-width row slot, not a two-chip
 * group) and is intentionally not folded in here. What WAS unified, on
 * 2026-07-30, is the thing that actually confused people: that control
 * used to be a bare 💵/🏦 with the meaning only in `title` — invisible on
 * touch. Every payment-method surface now NAMES the method in words.
 *
 * So the standing rule is: the word is the signal; the 💵/🏦 glyph is
 * decoration and may only ever appear ALONGSIDE it, never instead of it.
 * (That closes the "Phase 6 emoji sweep" question for this control — the
 * glyphs here are fine precisely because the label sits next to them.)
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
