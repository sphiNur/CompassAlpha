import { ChoiceGroup, Money } from '@compass/ui/kit';
import type { useI18n } from '../../../hooks/useI18n';
import { formatMoney } from '../../../lib/format';
import { fromDisplayPrice } from '../lib/priceMath';

type PriceUnit = 'thousands' | 'plain';

export interface PriceUnitProps {
  /** What is in the price field, as typed. */
  typed: string;
  /** Prices are typed in thousands ("12" for 12,000) when this is on. */
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  currency: string;
  /** What one of the product is counted in: the price is per this. */
  unit?: string;
  i18n: ReturnType<typeof useI18n>;
}

/**
 * Goes under every field a price is typed into. Typing "30" for 30,000
 * is the habit at the market, and the unit is remembered per phone, so
 * the same digits can mean two amounts: one lemon purchase was recorded
 * at 3,000,000, 3,000 and 30 before it landed on 30,000. Both units are
 * shown with the one in force marked, and the price is written out in
 * full so nobody multiplies in their head.
 */
export function PriceUnit({
  typed,
  priceInThousands,
  onTogglePriceUnit,
  currency,
  unit,
  i18n,
}: PriceUnitProps) {
  const raw = Number(fromDisplayPrice(typed.trim(), priceInThousands));
  const known = typed.trim() !== '' && Number.isFinite(raw) && raw > 0;
  const current: PriceUnit = priceInThousands ? 'thousands' : 'plain';
  return (
    <div className="flex flex-col gap-sm" data-testid="price-unit">
      <ChoiceGroup<PriceUnit>
        compact
        label={i18n.t('buy.priceUnit') as string}
        value={current}
        onChange={(next) => {
          if (next !== current) onTogglePriceUnit();
        }}
        options={[
          { value: 'thousands', label: `×1000 ${currency}` },
          { value: 'plain', label: currency },
        ]}
      />
      <div className="flex items-baseline justify-between gap-lg">
        <span className="text-body text-secondary">
          {unit
            ? (i18n.t('buy.priceInFullPer', { unit }) as string)
            : (i18n.t('buy.priceInFull') as string)}
        </span>
        <span data-testid="price-in-full">
          <Money amount={known ? formatMoney(raw) : '—'} currency={currency} />
        </span>
      </div>
    </div>
  );
}
