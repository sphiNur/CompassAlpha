import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn';
import { disabledClass } from './disabled';
import { fieldRequired, joinIds, useFieldControl } from './fieldControl';

/**
 * Textarea — multi-line text input. Sibling of `Input` for inputs
 * that need to wrap (notes, descriptions, "其他物品" free-text).
 *
 * Concord rules:
 *   - Default rows=3 — keeps the field visible-to-fold on mobile
 *     without dominating the screen. Caller can override.
 *   - Resize disabled (`resize-none`) so the field doesn't fight the
 *     surrounding layout. Review MWA-16 (V11, modern-web-guidance:
 *     form-fields-automatically-fit-contents): it grows with its text
 *     instead (`field-sizing: content`, `.textarea-grow` in tokens.css),
 *     from `rows` lines up to ten, then scrolls. Where the WebView lacks
 *     field-sizing it keeps its fixed `rows` and scrolls, as before.
 *   - Same shape primitives as Input: `rounded-[var(--r-card)]`
 *     (slightly less round than Input's pill since the field is
 *     visibly taller), `bg-[var(--c-surface-2)]`, `ring-field`,
 *     focus ring tokenized.
 *
 * The label, error and hint come from the `<Field>` around it (UI-02).
 */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 3, ...rest },
  ref,
) {
  // UI-02: a Field around the textarea shows its error and ties it here.
  const field = useFieldControl();
  const marked = !!invalid || !!field?.invalid;
  const required = fieldRequired(field, rest.required);
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        // D18: never shorter than a 44px field, even at rows={1}.
        'textarea-grow min-h-11 w-full resize-none rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2',
        'text-old-body leading-snug text-[var(--c-fg)]',
        'placeholder:text-[var(--c-fg-subtle)]',
        // V9: the field's edge at 3:1 against the page (--c-field-border).
        'outline-none ring-field',
        'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-ring-offset)]',
        disabledClass,
        marked && 'ring-2 ring-[var(--c-danger)]',
        className,
      )}
      {...rest}
      // MWA-16: the resting height in lines, for `.textarea-grow`.
      style={{ ['--textarea-rows' as string]: rows, ...rest.style }}
      // After the spread: what the caller passed adds to the field's own.
      id={rest.id ?? field?.id}
      // Review MWA-15 (modern-web-guidance: required-field-feedback): the
      // native `required` (it implies aria-required). The kit validates in
      // JS, so a <form> around a required field must be noValidate; none
      // is today (the two forms, sign-in and onboarding, mark no field).
      // aria-invalid is "false" until an error shows: Safari and Firefox
      // expose an empty required field as invalid from the start.
      required={required}
      aria-invalid={marked || rest['aria-invalid'] || (required ? false : undefined)}
      aria-required={required ? undefined : rest['aria-required']}
      aria-describedby={joinIds(field?.describedBy, rest['aria-describedby'])}
    />
  );
});
