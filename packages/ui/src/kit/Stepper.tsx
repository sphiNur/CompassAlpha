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
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

const CELL =
  'flex size-tap shrink-0 items-center justify-center text-h2 text-ink outline-none ' +
  'active:bg-line focus-visible:bg-line disabled:text-line';

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
  disabled = false,
  className,
  ...rest
}: StepperProps) {
  const labels = useUiLabels();
  const shown = (
    <>
      <span className="text-money">{value}</span>
      {unit ? <span className="ml-xs text-caption text-secondary">{unit}</span> : null}
    </>
  );
  const valueBox = 'flex h-tap min-w-row items-center justify-center border-x border-line px-sm';
  return (
    <div
      role="group"
      data-testid={rest['data-testid']}
      className={cn(
        'inline-flex shrink-0 items-stretch overflow-hidden rounded-pill bg-surface-sunken',
        className,
      )}
    >
      <button
        type="button"
        aria-label={labels.decrement}
        data-step="down"
        onClick={onDecrement}
        disabled={disabled || !canDecrement}
        className={CELL}
      >
        <span aria-hidden>−</span>
      </button>
      {onValuePress ? (
        <button
          type="button"
          data-step="value"
          onClick={onValuePress}
          disabled={disabled}
          className={cn(valueBox, 'outline-none active:bg-line')}
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
        className={CELL}
      >
        <span aria-hidden>+</span>
      </button>
    </div>
  );
}
