import { Segmented } from '@compass/ui';
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
  // DX-VIS-6 / DX-VIS-7 (2026-11-01): was two hand-rolled 32px buttons
  // whose state was colour only. Segmented gives each a 44px tap area and
  // tells a screen reader which method is selected.
  return (
    <Segmented
      className={className}
      value={value}
      onChange={onChange}
      ariaLabel={i18n.t('run.label.paymentMethod')}
      options={(['cash', 'transfer'] as const).map((m) => ({
        value: m,
        label: (
          <>
            <span aria-hidden>{m === 'cash' ? '💵 ' : '🏦 '}</span>
            {m === 'cash' ? i18n.t('run.label.paymentCash') : i18n.t('run.label.paymentTransfer')}
          </>
        ),
      }))}
    />
  );
}
