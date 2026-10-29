import { forwardRef } from 'react';
import type { ChangeEvent, InputHTMLAttributes } from 'react';
import { cn } from '../cn';
import { normalizeDecimalInput } from '../decimalText';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  // R6: a "number" field is a text field with the decimal keypad, so a
  // decimal comma is read instead of dropped; the value handed to
  // onChange is normalised (normalizeDecimalInput).
  const numeric = props.type === 'number';
  const rest = numeric
    ? {
        ...props,
        type: 'text',
        inputMode: props.inputMode ?? ('decimal' as const),
        onChange: props.onChange
          ? (e: ChangeEvent<HTMLInputElement>) => {
              const next = normalizeDecimalInput(e.target.value);
              if (next !== e.target.value) e.target.value = next;
              props.onChange!(e);
            }
          : undefined,
      }
    : props;
  return (
    <input
      ref={ref}
      // Height = --control-h (40px, the standard form-control tier;
      // M3.15 lowered it from 44→40 to match the Button md baseline so
      // an Input + Button row reads as same-rhythm controls). Select
      // shares this token so Input and Select finally line up. Text
      // stays text-old-h3 (14 px).
      className={cn(
        'h-[var(--control-h)] w-full min-w-0 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-old-h3',
        'text-[var(--c-fg)] placeholder:text-[var(--c-fg-subtle)]',
        'outline-none ring-hairline',
        'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-bg)]',
        invalid && 'ring-2 ring-[var(--c-danger)]',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
