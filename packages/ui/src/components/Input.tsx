import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn';
import { useUiLabels } from '../labels';
import { useDecimalField } from '../useDecimalField';
import { disabledClass } from './disabled';
import { FieldError } from './FieldError';

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
  const dateLike =
    props.type === 'date' ||
    props.type === 'time' ||
    props.type === 'datetime-local' ||
    props.type === 'month';
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
      // Height = --control-h (44px since D18, 2026-10-31; was 40). The md
      // Button and Select share the token, so an Input + Button row and
      // Input + Select still line up. Text stays text-old-h3 (14 px).
      className={cn(
        'h-[var(--control-h)] w-full min-w-0 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-old-h3',
        'text-[var(--c-fg)] placeholder:text-[var(--c-fg-subtle)]',
        // V9: the field's edge at 3:1 against the page (--c-field-border).
        'outline-none ring-field',
        'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-bg)]',
        disabledClass,
        // 2026-11-05: iOS draws date/time fields with the native control's
        // own minimum width and centred text, ignoring w-full — 营业日期 ran
        // past the card on iPhone. Without the native appearance the field
        // takes the width it is given and reads left-aligned like the others.
        dateLike &&
          'block appearance-none text-left [&::-webkit-date-and-time-value]:text-left [&::-webkit-date-and-time-value]:min-h-[1.25em] [&::-webkit-datetime-edit]:p-0',
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
      <FieldError>{labels.numberInvalid}</FieldError>
    </>
  );
});
