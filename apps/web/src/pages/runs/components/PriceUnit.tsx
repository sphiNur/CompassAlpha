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
import { formatMoney } from '../../../lib/format';
import { fromDisplayPrice } from '../lib/priceMath';

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
      className="press inline-flex shrink-0 items-center rounded-[var(--r-pill)] bg-[var(--c-surface-2)] p-0.5 text-old-label ring-hairline active:opacity-70"
    >
      <span className={segment(priceInThousands)}>×1000</span>
      <span className={segment(!priceInThousands)}>{currency}</span>
    </button>
  );
}

/** What the typed figure means in money, or nothing while it is not a number. */
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
  const raw = Number(fromDisplayPrice(typed.trim(), priceInThousands));
  if (!typed.trim() || !Number.isFinite(raw) || raw <= 0) return null;
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
