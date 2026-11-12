import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../cn';
import { disabledClass } from './disabled';
import { joinIds, useFieldControl } from './fieldControl';

/**
 * Select — native dropdown with Concord styling.
 *
 * Style parity with `Input`: both render at `--control-h` (44px), same
 * rounded pill shape, same surface + ring tokens. (Was h-11/44px and
 * drifted 4px above Input after M3.15 lowered Input to 40 — now both
 * read from the one token.) Visual difference: the right edge carries a
 * chevron, drawn in a span over the native control (appearance-none).
 *
 * Native `<select>` is the right choice for the Telegram Mini App
 * launch — opens the platform-native picker (iOS wheel / Android
 * sheet / desktop dropdown) which beats a custom Combobox for both
 * a11y and "feels like the OS". A future `<Combobox>` is on the
 * roadmap for cases where we need fuzzy search across many options.
 *
 * Caller composes `<option>` children. Optional `placeholder` prop
 * adds a disabled "" option as the first child.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  /** When set, prepends a disabled option with this text + value="". */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, placeholder, children, ...rest },
  ref,
) {
  // UI-02: a Field around the select shows its error and ties it here.
  const field = useFieldControl();
  const marked = !!invalid || !!field?.invalid;
  return (
    <span className="relative inline-flex w-full">
      <select
        ref={ref}
        className={cn(
          'h-[var(--control-h)] w-full appearance-none rounded-[var(--r-pill)] bg-[var(--c-surface-2)] pl-4 pr-9 text-old-h3',
          'text-[var(--c-fg)]',
          // V9: the field's edge at 3:1 against the page (--c-field-border).
          'outline-none ring-field',
          'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
          'focus-visible:ring-offset-[var(--c-ring-offset)]',
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
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      {/* Chevron — pure decorative, native select renders the
          platform's own picker affordance on tap; we just hint at
          dropdown-ness. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[var(--c-fg-subtle)]"
      >
        <svg width="12" height="8" viewBox="0 0 12 8" fill="none">
          <path
            d="M1 1.5l5 5 5-5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  );
});
