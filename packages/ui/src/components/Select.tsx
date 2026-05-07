import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Select — native dropdown with Concord styling.
 *
 * Style parity with `Input`: same height (h-11), same rounded pill
 * shape, same surface + ring tokens. Visual difference: the right
 * edge carries a chevron via background-image + appearance-none.
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

// Chevron icon as inline SVG → data URL. Kept as a const so we don't
// re-encode it on every render.
const CHEVRON =
  // eslint-disable-next-line max-len
  "data-[slot=chevron] url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5l5 5 5-5' stroke='%2399a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
void CHEVRON; // (reserved; we render the chevron via a sibling span)

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, placeholder, children, ...rest },
  ref,
) {
  return (
    <span className="relative inline-flex w-full">
      <select
        ref={ref}
        className={cn(
          'h-11 w-full appearance-none rounded-[var(--r-pill)] bg-[var(--c-surface-2)] pl-4 pr-9 text-h3',
          'text-[var(--c-fg)]',
          'outline-none ring-hairline',
          'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
          'focus-visible:ring-offset-[var(--c-bg)]',
          'disabled:opacity-60',
          invalid && 'ring-2 ring-[var(--c-danger)]',
          className,
        )}
        aria-invalid={invalid || undefined}
        {...rest}
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
