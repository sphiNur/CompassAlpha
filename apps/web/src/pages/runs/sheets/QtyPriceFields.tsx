/**
 * The quantity and unit price a purchase or an addition is recorded at,
 * with the switch for the unit the price is typed in and what the typed
 * figure comes to (PriceUnit.tsx). The purchase sheet and the "+ add"
 * sheet each wrote these out (review RUNWEB2-09).
 *
 * The price field shows what was typed (`priceText`); the sheet keeps the
 * price itself in its draft, in whole currency units (M3.36).
 */
import { Field, Input } from '@compass/ui';
import { useCurrency } from '../../../hooks/useCurrency';
import { useI18n } from '../../../hooks/useI18n';
import { PriceInFull, PriceUnitSwitch } from '../components/PriceUnit';

export function QtyPriceFields({
  qtyUnit,
  qty,
  onQty,
  qtyLocked,
  autoFocusQty,
  priceText,
  onPriceText,
  priceUnit,
  priceInThousands,
  onTogglePriceUnit,
}: {
  /** The quantity's unit, as people read it; none for an expense without one. */
  qtyUnit: string | undefined;
  qty: string;
  onQty: (qty: string) => void;
  /** The goods already went to a store: the quantity stays as it is. */
  qtyLocked?: boolean;
  autoFocusQty?: boolean;
  priceText: string;
  onPriceText: (text: string) => void;
  /** What the price is per, shown with the price in full. */
  priceUnit?: string;
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
}) {
  const i18n = useI18n();
  const currency = useCurrency();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {/* R2-BUY-4: the localised unit ("升"), not the code ("L"); no
            empty brackets when there is none. */}
        <Field
          label={
            qtyUnit
              ? i18n.t('run.action.actualQty', { unit: qtyUnit })
              : i18n.t('run.action.actualQtyPlain')
          }
        >
          <Input
            type="number"
            value={qty}
            onChange={(e) => onQty(e.target.value)}
            disabled={qtyLocked}
            autoFocus={autoFocusQty}
          />
        </Field>
        <Field
          label={
            priceInThousands
              ? i18n.t('run.action.unitPriceUzsThousands', { currency })
              : i18n.t('run.action.unitPriceUzs', { currency })
          }
        >
          <Input
            type="number"
            inputMode="decimal"
            value={priceText}
            onChange={(e) => onPriceText(e.target.value)}
          />
        </Field>
      </div>
      {/* Which unit the price is in, and what it comes to. See PriceUnit.tsx. */}
      <div className="flex items-center justify-between gap-2 text-old-label text-[var(--c-fg-muted)]">
        <PriceUnitSwitch
          priceInThousands={priceInThousands}
          onToggle={onTogglePriceUnit}
          currency={currency}
          ariaLabel={i18n.t('run.label.priceUnitAria', { currency })}
        />
        <span className="min-w-0 text-right">
          <PriceInFull
            typed={priceText}
            priceInThousands={priceInThousands}
            currency={currency}
            unit={priceUnit}
          />
        </span>
      </div>
    </>
  );
}
