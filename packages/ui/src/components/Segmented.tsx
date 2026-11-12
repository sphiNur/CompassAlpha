import type { ReactNode } from 'react';
import { cn } from '../cn';
import { useRovingRadio } from '../rovingRadio';

/**
 * Segmented control — a compact N-option toggle where exactly ONE
 * option is active at a time. The kit's two "pick one" controls
 * (UI_STANDARDS UI-16; review UI-32 removed a third, Tabs):
 *
 *   - Chip + ChipBar: filtering a list by category. Pills that
 *     scroll sideways when the row overflows.
 *   - Segmented: switching between views, or a tight bounded set
 *     (2-4 options) that drives one piece of state. NEVER scrolls —
 *     overflow is a contract bug. Also used for form-field toggles
 *     (kg vs lb, 0.5 vs 1).
 *
 * Added M3.16 (2026-05-16) to consolidate three inline segmented
 * patterns that had drifted across AdminPage (Finance range preset,
 * Finance view toggle, SKU step picker in M3.14). Each had its own
 * height, font size, and active-state color — a real eyesore once
 * the user started comparing pages side-by-side.
 *
 * Design:
 *   - Default size `md` (h-9, text-old-body-sm 12 px) — matches the
 *     M3.15 nav-bar baseline and lives comfortably inside a Field.
 *   - `sm` variant (h-7, text-old-label 11 px) — for nested-in-row use
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
 *
 * Keyboard (review UI-07, 2026-11-11), as in ChipBar and PickerGroup
 * (A11Y-15): the control is one Tab stop and the arrow keys move between
 * the options, past disabled ones. Every option used to be its own Tab
 * stop and the arrows did nothing.
 */

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Per-option active background override. Defaults to action. */
  activeBg?: string;
  /** Per-option active foreground override. Defaults to action-fg. */
  activeFg?: string;
  /**
   * The option cannot be chosen; the caller says why next to the control
   * (ADM1-07: an "Allow" the actor may not give). A chosen option stays
   * shown as chosen.
   */
  disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  value: V;
  options: ReadonlyArray<SegmentedOption<V>>;
  onChange: (next: V) => void;
  size?: 'sm' | 'md';
  /** Stretch options to equal width (default true). */
  equalWidth?: boolean;
  /**
   * What is being chosen, announced to screen readers. Required since
   * UI-07: three controls named nothing but their options.
   */
  ariaLabel: string;
  className?: string;
  /**
   * Nothing can be chosen (UI-07: this used to block only the pointer,
   * and Space still chose). The options stay focusable, so focus is not
   * lost while a save disables the control for a moment.
   */
  disabled?: boolean;
  /**
   * An arrow key also chooses the option it moves to (default). Pass
   * false where choosing does real work (a permission saved on change),
   * so arrows only move focus and Space / Enter chooses.
   */
  followFocus?: boolean;
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
  followFocus = true,
}: SegmentedProps<V>) {
  const isSm = size === 'sm';
  const roving = useRovingRadio<HTMLDivElement>({ followFocus: followFocus && !disabled });
  return (
    <div
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        // V4 (2026-10-30): no overflow-hidden — it clipped the segments'
        // hit-44 tap areas. The end segments round their own corners.
        'flex rounded-[var(--r-utility)] ring-hairline',
        isSm ? 'h-7' : 'h-[var(--control-h-sm)]',
        disabled && 'opacity-50',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const blocked = disabled || opt.disabled;
        const activeBg = opt.activeBg ?? 'bg-[var(--c-action)]';
        const activeFg = opt.activeFg ?? 'text-[var(--c-action-fg)]';
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={opt.disabled}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (!blocked && !active) onChange(opt.value);
            }}
            className={cn(
              'hit-44 inline-flex items-center justify-center whitespace-nowrap font-medium tabular-nums',
              !blocked && 'press',
              'first:rounded-l-[var(--r-utility)] last:rounded-r-[var(--r-utility)]',
              isSm ? 'px-2 text-old-label' : 'px-3 text-old-body-sm',
              // 2026-11-05: min-w-0 on equal segments — a long ru/uz label
              // used to widen the bar past a narrow screen. The label span
              // truncates, not the button: a button that hides its overflow
              // clips its own hit-44 area (review UI-06, 2026-11-09), as in
              // Button.
              equalWidth ? 'min-w-0 flex-1' : 'shrink-0',
              active
                ? `${activeBg} ${activeFg} font-semibold`
                : 'bg-[var(--c-surface)] text-[var(--c-fg-muted)]',
              blocked && 'cursor-not-allowed',
              opt.disabled && !disabled && !active && 'opacity-40',
            )}
          >
            <span className={equalWidth ? 'min-w-0 truncate' : undefined}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
