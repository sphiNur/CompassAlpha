import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn';

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  size?: 'sm' | 'md';
  /** Visual width preset. `auto` lets the parent flex/grid drive width. */
  width?: 'auto' | 'narrow' | 'wide';
  /** Display 1 decimal max, no trailing zeros (formatQty pattern). */
  oneDecimal?: boolean;
}

/**
 * Numeric input with mobile-friendly defaults: `inputMode="decimal"`
 * triggers the iOS numeric keyboard, `step` and `min` are configurable
 * by caller, and visual styling matches our other form inputs.
 *
 * Replaces the 6+ raw `<input type="number">` instances that were
 * scattered across RunPage / PurchaseSheet / etc. Inline number entry
 * (qty, price, splits) all funnel through here so behavior +
 * styling stay identical.
 *
 * Width presets are deliberate: `narrow` (≈5rem) is for qty fields
 * inside dense flex rows where overflow was previously a problem on
 * iOS Telegram WebView. `wide` (1fr in a grid) is for price fields.
 * `auto` lets the parent control width (e.g. inside a CSS grid).
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput({ className, size = 'md', width = 'auto', oneDecimal: _oneDecimal, ...rest }, ref) {
    void _oneDecimal; // reserved for future use; kept on the prop type for clarity
    // Capsule-pass ladder: md = --control-h-sm (32px capsule tier),
    // sm = --control-h-xs (28px dense tier).
    const hSize = size === 'sm' ? 'h-[var(--control-h-xs)]' : 'h-[var(--control-h-sm)]';
    const w =
      width === 'narrow' ? 'w-20' : width === 'wide' ? 'w-full' : 'w-full min-w-0';
    // Capsule pass (2026-07-31): was the one input with a real border +
    // focus:border treatment — now the same flat filled capsule and
    // system focus ring as Input/Select/SearchInput.
    return (
      <input
        ref={ref}
        type="number"
        inputMode="decimal"
        className={cn(
          hSize,
          w,
          'min-w-0 rounded-[var(--r-pill)]',
          'bg-[var(--c-surface-2)] px-3 text-h3 tabular-nums outline-none',
          'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
          'focus-visible:ring-offset-[var(--c-bg)]',
          rest.disabled ? 'opacity-50' : '',
          className,
        )}
        {...rest}
      />
    );
  },
);
