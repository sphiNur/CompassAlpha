import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * SearchInput — text field with leading magnifier icon + trailing
 * clear button. Sibling of `Input` for the specific search-bar UX.
 *
 * Why not just use Input with a leading-slot prop:
 *   - The clear button needs to know `value` and call back to the
 *     caller's `onChange` with empty string. Bolting that onto Input
 *     would muddle Input's "minimal pass-through" role.
 *   - The cluster of icon+input+clear has its own padding semantics
 *     (icon eats 8px on the left, clear sits 8px from the right).
 *
 * Design choice: the clear button only renders when `value` is
 * non-empty; the icon is always visible. Same focus-ring + token
 * surface as Input. role="search" gives screen readers "search"
 * announcement instead of generic "edit".
 */
export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Fires when the trailing X button is tapped. Optional — if not
   *  provided, the helper synthesizes a synthetic onChange with ''. */
  onClear?: () => void;
  /** Localized label for the clear button (a11y). */
  clearAriaLabel?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { className, value, onChange, onClear, clearAriaLabel = 'Clear search', ...rest },
  ref,
) {
  const hasValue = typeof value === 'string' && value.length > 0;
  return (
    <div role="search" className={cn('relative min-w-0', className)}>
      {/* Leading magnifier — pure decoration, no interaction. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[var(--c-fg-subtle)]"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M11 11l3 3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={onChange}
        // M3.15 (2026-05-16): shrunk from the 40px field tier so search
        // eats less viewport above dense lists. Capsule pass 2026-07-31:
        // --control-h-sm is now the 32px capsule tier — same height as
        // the chip strip it sits above — and the resting hairline is
        // gone (flat filled capsule, like Telegram's own search field).
        className={cn(
          'h-[var(--control-h-sm)] w-full min-w-0 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] pl-9 pr-10 text-body-sm',
          'text-[var(--c-fg)] placeholder:text-[var(--c-fg-subtle)]',
          'outline-none',
          'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
          'focus-visible:ring-offset-[var(--c-bg)]',
          // The browser's native `<input type=search>` cancel decoration
          // collides with our X button on WebKit. Hide it.
          '[&::-webkit-search-cancel-button]:appearance-none',
          '[&::-webkit-search-decoration]:appearance-none',
        )}
        {...rest}
      />
      {hasValue ? (
        <button
          type="button"
          aria-label={clearAriaLabel}
          onClick={() => {
            if (onClear) {
              onClear();
              return;
            }
            // Synthesize a change event with empty value so the
            // caller's onChange handler sees the clear in the same
            // shape as a normal keystroke.
            const target = (
              document.activeElement instanceof HTMLInputElement
                ? document.activeElement
                : null
            ) as HTMLInputElement | null;
            if (onChange && target) {
              const synthetic = {
                ...({} as React.ChangeEvent<HTMLInputElement>),
                currentTarget: { ...target, value: '' } as HTMLInputElement,
                target: { ...target, value: '' } as HTMLInputElement,
              };
              onChange(synthetic as React.ChangeEvent<HTMLInputElement>);
            }
          }}
          className={cn(
            'absolute inset-y-0 right-1 flex w-8 items-center justify-center',
            'text-[var(--c-fg-muted)] hover:text-[var(--c-fg)]',
            'focus-visible:outline-none focus-visible:rounded-full',
            'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)]',
          )}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="6" fill="currentColor" opacity="0.15" />
            <path
              d="M4.5 4.5l5 5M9.5 4.5l-5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
});
