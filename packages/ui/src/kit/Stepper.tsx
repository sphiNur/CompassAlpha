import type { ReactNode } from 'react';
import { cn } from '../cn';
import { useUiLabels } from '../labels';

export interface StepperProps {
  /** The quantity as shown, e.g. "2" or "0.5". */
  value: string;
  /** Unit after the number ("kg"). Part of what is read aloud. */
  unit?: ReactNode;
  onDecrement: () => void;
  onIncrement: () => void;
  /** Tapping the number, for typing an exact quantity. */
  onValuePress?: () => void;
  canDecrement?: boolean;
  canIncrement?: boolean;
  /**
   * Nothing here yet. The control is all there, but without the accent
   * and with a faint figure: in a long list where most rows are zero,
   * colour is left for the rows that have a quantity.
   */
  quiet?: boolean;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

// Each end is a round button of its own, a full 44px target.
const CELL =
  'flex size-tap shrink-0 items-center justify-center rounded-pill text-h2 outline-none ' +
  'disabled:opacity-40';
// Taking away is the quiet one; adding carries the accent, so a row that
// has a quantity is the row with colour in it.
const LESS = 'bg-surface-sunken text-ink active:bg-line focus-visible:bg-line';
const MORE =
  'bg-primary text-on-primary active:bg-primary-pressed focus-visible:bg-primary-pressed';

/**
 * Quantity up and down. Each of the three cells is a full 44px target,
 * because this is used one-handed, in a market, sometimes in gloves.
 */
export function Stepper({
  value,
  unit,
  onDecrement,
  onIncrement,
  onValuePress,
  canDecrement = true,
  canIncrement = true,
  quiet = false,
  disabled = false,
  className,
  ...rest
}: StepperProps) {
  const labels = useUiLabels();
  const shown = (
    <>
      <span className={cn('text-money', quiet && 'text-secondary')}>{value}</span>
      {unit ? <span className="ms-xs text-caption text-secondary">{unit}</span> : null}
    </>
  );
  // The figure stands between them on the page itself, no box around it.
  const valueBox = 'flex h-tap min-w-row items-center justify-center rounded-pill px-sm text-ink';
  return (
    <div
      role="group"
      dir="ltr"
      data-testid={rest['data-testid']}
      className={cn('inline-flex shrink-0 items-center gap-xs', className)}
    >
      <button
        type="button"
        aria-label={labels.decrement}
        data-step="down"
        onClick={onDecrement}
        disabled={disabled || !canDecrement}
        className={cn(CELL, LESS)}
      >
        <span aria-hidden>−</span>
      </button>
      {onValuePress ? (
        <button
          type="button"
          data-step="value"
          onClick={onValuePress}
          disabled={disabled}
          className={cn(valueBox, 'outline-none active:bg-surface-sunken')}
        >
          {shown}
        </button>
      ) : (
        <span data-step="value" className={valueBox}>
          {shown}
        </span>
      )}
      <button
        type="button"
        aria-label={labels.increment}
        data-step="up"
        onClick={onIncrement}
        disabled={disabled || !canIncrement}
        className={cn(CELL, quiet ? LESS : MORE)}
      >
        <span aria-hidden>+</span>
      </button>
    </div>
  );
}
