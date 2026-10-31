import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn';
import { useUiLabels } from '../labels';
import { useDecimalField } from '../useDecimalField';

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  size?: 'sm' | 'md';
  /** Visual width preset. `auto` lets the parent flex/grid drive width. */
  width?: 'auto' | 'narrow' | 'wide';
  /** Display 1 decimal max, no trailing zeros (formatQty pattern). */
  oneDecimal?: boolean;
  /**
   * R2-ORD-2 (2026-10-31): text that is not one number ("1e3", "1.2.3")
   * is kept and marked invalid; by default a line under the field says
   * so. `none` for a caller that already shows its own message.
   */
  formatError?: 'inline' | 'none';
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
  function NumberInput(
    {
      className,
      size = 'md',
      width = 'auto',
      oneDecimal: _oneDecimal,
      formatError = 'inline',
      value,
      onChange,
      onBlur,
      ...rest
    },
    ref,
  ) {
    void _oneDecimal; // reserved for future use; kept on the prop type for clarity
    const labels = useUiLabels();
    // RE-CLS-4 / R2-ORD-1: the typed text stays while typing; the parent
    // gets the normalised reading of the whole text. See useDecimalField.
    const { inputProps, invalid } = useDecimalField({ value, onChange, onBlur });
    // md = --control-h-sm (36px, the compact-control tier); sm = h-8 (32px).
    const hSize = size === 'sm' ? 'h-8' : 'h-[var(--control-h-sm)]';
    const w =
      width === 'narrow' ? 'w-20' : width === 'wide' ? 'w-full' : 'w-full min-w-0';
    const input = (
      <input
        ref={ref}
        // R6: text + decimal keypad, so "1,5" is read as 1.5 instead of
        // being dropped by type="number".
        type="text"
        inputMode="decimal"
        className={cn(
          hSize,
          w,
          // V9: the field's edge at 3:1 against the page.
          'min-w-0 rounded-[var(--r-pill)] border border-[var(--c-field-border)]',
          'bg-[var(--c-surface-2)] px-3 text-old-h3 tabular-nums outline-none',
          // V8: the browser's default placeholder grey was 2.19:1 here.
          'placeholder:text-[var(--c-fg-subtle)]',
          'focus:border-[var(--c-action)]',
          invalid ? 'border-[var(--c-danger)]' : '',
          rest.disabled ? 'opacity-50' : '',
          className,
        )}
        {...rest}
        {...inputProps}
        aria-invalid={invalid || rest['aria-invalid'] || undefined}
      />
    );
    if (!invalid || formatError === 'none') return input;
    return (
      <>
        {input}
        <span role="alert" className="block text-old-label text-[var(--c-danger)]">
          {labels.numberInvalid}
        </span>
      </>
    );
  },
);
