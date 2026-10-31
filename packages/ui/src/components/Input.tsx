import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn';
import { useUiLabels } from '../labels';
import { useDecimalField } from '../useDecimalField';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  // R6: a "number" field is a text field with the decimal keypad, so a
  // decimal comma is read instead of dropped. RE-CLS-4 / R2-ORD-1: the
  // typed text stays while typing and the parent gets the normalised
  // reading of the whole text (useDecimalField); text that is not one
  // number is marked invalid instead of being guessed at.
  const numeric = props.type === 'number';
  const labels = useUiLabels();
  const decimal = useDecimalField({
    value: props.value,
    onChange: props.onChange,
    onBlur: props.onBlur,
  });
  const formatInvalid = numeric && decimal.invalid;
  const rest = numeric
    ? {
        ...props,
        type: 'text',
        inputMode: props.inputMode ?? ('decimal' as const),
        ...decimal.inputProps,
      }
    : props;
  const input = (
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
        // V9: the field's edge at 3:1 against the page (--c-field-border).
        'outline-none ring-field',
        'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-bg)]',
        (invalid || formatInvalid) && 'ring-2 ring-[var(--c-danger)]',
        className,
      )}
      aria-invalid={invalid || formatInvalid || undefined}
      {...rest}
    />
  );
  if (!formatInvalid) return input;
  return (
    <>
      {input}
      <span role="alert" className="mt-1 block text-old-label text-[var(--c-danger)]">
        {labels.numberInvalid}
      </span>
    </>
  );
});
