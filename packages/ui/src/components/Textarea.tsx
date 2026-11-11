import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn';
import { disabledClass } from './disabled';
import { joinIds, useFieldControl } from './fieldControl';

/**
 * Textarea — multi-line text input. Sibling of `Input` for inputs
 * that need to wrap (notes, descriptions, "其他物品" free-text).
 *
 * Concord rules:
 *   - Default rows=3 — keeps the field visible-to-fold on mobile
 *     without dominating the screen. Caller can override.
 *   - Resize disabled (`resize-none`) so the field doesn't fight the
 *     surrounding layout. If a Telegram WebView user really needs
 *     more room, they scroll within the textarea.
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
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        // D18: never shorter than a 44px field, even at rows={1}.
        'min-h-11 w-full resize-none rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2',
        'text-old-body leading-snug text-[var(--c-fg)]',
        'placeholder:text-[var(--c-fg-subtle)]',
        // V9: the field's edge at 3:1 against the page (--c-field-border).
        'outline-none ring-field',
        'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-bg)]',
        disabledClass,
        marked && 'ring-2 ring-[var(--c-danger)]',
        className,
      )}
      {...rest}
      // After the spread: what the caller passed adds to the field's own.
      id={rest.id ?? field?.id}
      aria-invalid={marked || rest['aria-invalid'] || undefined}
      aria-required={field?.required || rest['aria-required'] || undefined}
      aria-describedby={joinIds(field?.describedBy, rest['aria-describedby'])}
    />
  );
});
