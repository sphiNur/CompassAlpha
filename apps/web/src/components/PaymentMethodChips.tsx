import { Segmented } from '@compass/ui';
import type { PaymentMethod } from '@compass/contracts';
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
 * Review COREWEB1-23 (2026-11-11): the word is the signal, so the 💵/🏦
 * that sat next to it is gone too (UI-1: no glyph beside text that says
 * the same thing).
 */
export interface PaymentMethodChipsProps {
  value: PaymentMethod;
  onChange: (method: PaymentMethod) => void;
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
        label: m === 'cash' ? i18n.t('run.label.paymentCash') : i18n.t('run.label.paymentTransfer'),
      }))}
    />
  );
}
