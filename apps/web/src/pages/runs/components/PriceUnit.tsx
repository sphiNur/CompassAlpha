/**
 * The two things that keep a price from being typed in the wrong unit
 * (2026-10-11). Prices are typed in thousands by default ("30" for
 * 30,000) and the mode is remembered per phone, so the same digits can
 * mean two amounts. Production data showed what that costs: one lemon
 * purchase recorded at 3,000,000, 3,000 and 30 before it landed on
 * 30,000.
 *
 *   - PriceUnitSwitch  both units visible, the one in force filled in.
 *                      Every place a price is typed carries it.
 *   - PriceInFull      the amount that will be saved, written out, next
 *                      to the field — nobody has to multiply in their
 *                      head to see that "30000" became thirty million.
 */
import { useI18n } from '../../../hooks/useI18n';
import { formatMoney } from '../../../lib/format';
import { readDisplayPrice } from '../lib/priceMath';

export function PriceUnitSwitch({
  priceInThousands,
  onToggle,
  currency,
  ariaLabel,
}: {
  priceInThousands: boolean;
  onToggle: () => void;
  currency: string;
  ariaLabel: string;
}) {
  const segment = (active: boolean) =>
    active
      ? 'rounded-[var(--r-pill)] bg-[var(--c-action)] px-2 py-1 font-semibold text-[var(--c-action-fg)]'
      : 'rounded-[var(--r-pill)] px-2 py-1 text-[var(--c-fg-muted)]';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={ariaLabel}
      data-testid="price-unit-switch"
      className="press hit-44 inline-flex shrink-0 items-center rounded-[var(--r-pill)] bg-[var(--c-surface-2)] p-0.5 text-old-label ring-hairline active:opacity-70"
    >
      <span className={segment(priceInThousands)}>×1000</span>
      <span className={segment(!priceInThousands)}>{currency}</span>
    </button>
  );
}

/**
 * What the typed figure means in money, or nothing while the field is
 * empty. R2-BUY-2 (2026-10-31): a figure the server would refuse (a 3rd
 * decimal, a 13th digit, 0, text) says so here instead of previewing a
 * rounded amount that is then refused on save.
 */
export function PriceInFull({
  typed,
  priceInThousands,
  currency,
  unit,
}: {
  typed: string;
  priceInThousands: boolean;
  currency: string;
  unit?: string;
}) {
  const i18n = useI18n();
  if (!typed.trim()) return null;
  const raw = readDisplayPrice(typed, priceInThousands);
  if (raw === null) {
    return (
      <span role="alert" data-testid="price-format-error" className="text-[var(--c-danger)]">
        {i18n.t('run.errors.priceFormat')}
      </span>
    );
  }
  return (
    <span
      data-testid="price-in-full"
      className="font-mono font-semibold tabular-nums text-[var(--c-fg)]"
    >
      {formatMoney(raw)} {currency}
      {unit ? <span className="font-sans font-normal text-[var(--c-fg-muted)]"> / {unit}</span> : null}
    </span>
  );
}
