import { forwardRef, useEffect, useId } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn';
import { useUiLabels } from '../labels';
import { useDecimalField } from '../useDecimalField';
import { disabledClass } from './disabled';
import { FieldError } from './FieldError';
import { joinIds, useFieldControl } from './fieldControl';

type FieldAttributes = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * A number field. Review CONF-22 (2026-11-11): no min / max / step. The
 * field is text (R6), so the browser checks none of them; passing them
 * read as a range check that did not happen. A caller says what is wrong
 * itself (`invalid` and its own FieldError).
 */
interface NumberFieldProps extends Omit<FieldAttributes, 'min' | 'max' | 'step'> {
  type: 'number';
  min?: never;
  max?: never;
  step?: never;
  /** Draws the red ring and sets aria-invalid. */
  invalid?: boolean;
  /**
   * R2-ORD-2: text that is not one number ("1e3", "1.2.3") is kept and
   * marked invalid, and by default a line under the field says so.
   * `none` for a caller that shows its own message.
   */
  formatError?: 'inline' | 'none';
}

interface TextFieldProps extends FieldAttributes {
  type?:
    | 'text'
    | 'search'
    | 'password'
    | 'email'
    | 'tel'
    | 'url'
    | 'date'
    | 'time'
    | 'datetime-local'
    | 'month';
  /** Draws the red ring and sets aria-invalid. */
  invalid?: boolean;
  formatError?: never;
}

export type InputProps = NumberFieldProps | TextFieldProps;

/**
 * The kit's text field. Review UI-12 (2026-11): it is also the number
 * field (type="number"); a second component with its own border, focus
 * edge and error look made one quantity look different in a run row and
 * in its edit sheet.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, formatError = 'inline', ...props },
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
  // UI-02: a Field around the input shows its error and ties it here.
  const field = useFieldControl();
  const marked = !!invalid || formatInvalid || !!field?.invalid;
  const formatLine = formatInvalid && formatError === 'inline';
  const controlId = useId();
  const formatErrorId = useId();
  const reportFormatError = field?.reportFormatError;
  useEffect(() => {
    if (!reportFormatError) return;
    reportFormatError(controlId, formatLine);
    return () => reportFormatError(controlId, false);
  }, [reportFormatError, controlId, formatLine]);
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
        // Digits of a number line up with the numbers around them.
        numeric && 'tabular-nums',
        marked && 'ring-2 ring-[var(--c-danger)]',
        className,
      )}
      {...rest}
      // After the spread: what the caller passed adds to the field's own.
      id={props.id ?? field?.id}
      aria-invalid={marked || props['aria-invalid'] || undefined}
      aria-required={field?.required || props['aria-required'] || undefined}
      aria-describedby={joinIds(
        field?.describedBy,
        props['aria-describedby'],
        !field && formatLine && formatErrorId,
      )}
    />
  );
  // Inside a Field the "not one number" line is the Field's to draw.
  if (field || !formatLine) return input;
  return (
    <>
      {input}
      <FieldError id={formatErrorId}>{labels.numberInvalid}</FieldError>
    </>
  );
});
