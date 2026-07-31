import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Checkbox — a clickable square with a checkmark.
 *
 * Concord rules:
 *   - Always pair with a label (the `label` prop OR an external <label>
 *     wrapping it). Bare checkboxes lose context for screen readers
 *     AND grow the tap-target only on the box itself.
 *   - The whole label area is the tap-target — 44×24min iOS HIG.
 *   - When disabled, opacity drops; the surrounding label dims too so
 *     the user understands the row is non-interactive, not just the
 *     box.
 *
 * Built on a native `<input type="checkbox">` for free a11y (Tab,
 * Space, screen-reader announces "checked / not checked"). The visual
 * box is a sibling overlay; the native input is `sr-only` so it
 * doesn't double-render but stays focusable.
 */
export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Optional inline label rendered to the right of the box. */
  label?: ReactNode;
  /** Optional sub-label — smaller, muted. */
  hint?: ReactNode;
  /** Visual + aria invalid state. */
  invalid?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, label, hint, invalid, disabled, id, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  // Tailwind `peer-*` variants reach the immediate sibling; we use
  // `peer-checked:[&_svg]:opacity-100` to toggle the checkmark's
  // visibility from inside the box span. The SVG always renders but
  // is invisible until the box is checked.
  const box = (
    <span
      aria-hidden
      className={cn(
        'peer-checked:[&_svg]:opacity-100',
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--r-utility)]',
        'bg-[var(--c-surface-2)] ring-hairline transition-colors',
        'peer-checked:bg-[var(--c-action)] peer-checked:ring-[var(--c-action)]',
        'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--c-ring)] peer-focus-visible:ring-offset-2',
        'peer-focus-visible:ring-offset-[var(--c-bg)]',
        'peer-disabled:opacity-50',
        invalid && 'ring-2 ring-[var(--c-danger)]',
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3 w-3 text-[var(--c-action-fg)] opacity-0 transition-opacity"
      >
        <path
          d="M3.5 8.5l3 3 6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );

  const native = (
    <input
      ref={ref}
      type="checkbox"
      id={inputId}
      disabled={disabled}
      className="peer sr-only"
      aria-invalid={invalid || undefined}
      aria-describedby={hintId}
      {...rest}
    />
  );

  // When the prop carries a label, we render a self-contained <label>
  // wrapping the native input + visible box + label text. When no
  // label prop, return just the native+box pair so the caller can
  // wrap them in their own <label>.
  if (label === undefined) {
    return (
      <span className={cn('inline-flex items-center', className)}>
        {native}
        {box}
      </span>
    );
  }

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'press flex cursor-pointer items-start gap-2 rounded-[var(--r-utility)] py-1.5',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      {native}
      {box}
      <span className="flex min-w-0 flex-col">
        <span className="text-body text-[var(--c-fg)]">{label}</span>
        {hint ? (
          <span id={hintId} className="text-label text-[var(--c-fg-muted)]">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
});
