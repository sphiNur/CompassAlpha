import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Segmented control — a compact N-option toggle where exactly ONE
 * option is active at a time. Sibling of `Tabs` / `Chip` but tuned
 * for the "swap a small piece of UI state" role:
 *
 *   - Tabs: switches BETWEEN content panels. Roving-tabindex, aria
 *     `role="tablist"`, owned per page.
 *   - Chip + ChipBar: filter pills with optional multi-select.
 *     Horizontally scrolls when the row overflows.
 *   - Segmented: a tight bounded set (2-4 options) that drives one
 *     piece of state. NEVER scrolls — overflow is a contract bug.
 *     Used for form-field toggles (kg vs lb, 0.5 vs 1) and for
 *     "compact filter" rows where Tabs would feel too heavy.
 *
 * Added M3.16 (2026-05-16) to consolidate three inline segmented
 * patterns that had drifted across AdminPage (Finance range preset,
 * Finance view toggle, SKU step picker in M3.14). Each had its own
 * height, font size, and active-state color — a real eyesore once
 * the user started comparing pages side-by-side.
 *
 * Design:
 *   - Default size `md` (h-9, text-body-sm 12 px) — matches the
 *     M3.15 nav-bar baseline and lives comfortably inside a Field.
 *   - `sm` variant (h-7, text-label 11 px) — for nested-in-row use
 *     like the Permissions matrix (allow/deny/inherit). Acts like
 *     SegBtn but reusable.
 *   - Single hairline ring + a sliding active background (action
 *     color by default; callers can override per-option via the
 *     `activeBg` field on the option object — used by the
 *     Permissions matrix to color allow=success / deny=danger).
 *
 * Layout choice: a flex row with `overflow-hidden` on the rounded
 * frame. Options stretch to equal width via `flex-1` so the control
 * fills its parent. If the caller wants intrinsic-width segments
 * (e.g. "Week / Month / Quarter / Year" where Q feels smaller),
 * set `equalWidth={false}` and segments size to content.
 */

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Per-option active background override. Defaults to action. */
  activeBg?: string;
  /** Per-option active foreground override. Defaults to action-fg. */
  activeFg?: string;
}

export interface SegmentedProps<V extends string> {
  value: V;
  options: ReadonlyArray<SegmentedOption<V>>;
  onChange: (next: V) => void;
  size?: 'sm' | 'md';
  /** Stretch options to equal width (default true). */
  equalWidth?: boolean;
  /** Accessible label announced to screen readers. */
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  size = 'md',
  equalWidth = true,
  ariaLabel,
  className,
  disabled,
}: SegmentedProps<V>) {
  const isSm = size === 'sm';
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'flex overflow-hidden rounded-[var(--r-utility)] ring-hairline',
        isSm ? 'h-7' : 'h-[var(--control-h-sm)]',
        disabled && 'opacity-50 pointer-events-none',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const activeBg = opt.activeBg ?? 'bg-[var(--c-action)]';
        const activeFg = opt.activeFg ?? 'text-[var(--c-action-fg)]';
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            className={cn(
              'press inline-flex items-center justify-center whitespace-nowrap font-medium tabular-nums',
              isSm ? 'px-2 text-label' : 'px-3 text-body-sm',
              equalWidth ? 'flex-1' : 'shrink-0',
              active
                ? `${activeBg} ${activeFg} font-semibold`
                : 'bg-[var(--c-surface)] text-[var(--c-fg-muted)]',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
