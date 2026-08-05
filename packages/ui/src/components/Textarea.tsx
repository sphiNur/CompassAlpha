import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn';

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
 *     visibly taller), `bg-[var(--c-surface-2)]`, `ring-hairline`,
 *     focus ring tokenized.
 *
 * Doesn't (yet) carry a built-in label / error slot — that's planned
 * as part of the broader Input + Field overhaul. Pair with the
 * existing `<Field label=...>` row helper in `Rows.tsx` for now.
 */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 3, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      // Capsule pass (2026-07-31): flat filled field, no resting
      // hairline; px-4 aligns the caret gutter with Input's.
      className={cn(
        'w-full resize-none rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2',
        'text-body leading-snug text-[var(--c-fg)]',
        'placeholder:text-[var(--c-fg-subtle)]',
        'outline-none',
        'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-bg)]',
        'disabled:opacity-60',
        invalid && 'ring-2 ring-[var(--c-danger)]',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
