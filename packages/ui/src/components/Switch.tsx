import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Switch — iOS-style toggle for binary on/off state.
 *
 * Use Switch (not Checkbox) when:
 *   - The change takes effect IMMEDIATELY (no submit step). Examples:
 *     "Active" toggle on a store, "Notifications on" preference.
 *   - The state has clear on/off semantics that don't fit a checked-list
 *     mental model.
 *
 * Use Checkbox when:
 *   - The change is part of a form submitted later
 *   - Multiple options compose (a list of feature flags)
 *
 * Built on a native `<input type="checkbox" role="switch">`. The role
 * override is what makes screen readers announce "switch, on/off"
 * instead of "checkbox, checked/not checked".
 */
export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, label, hint, disabled, id, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  // Track + thumb. The `peer-checked:` variants light up the track
  // (which IS the input's sibling) and reach the thumb (a child of
  // the track) via `peer-checked:[&>span]:translate-x-3`.
  // ~32×20 px track / 16 px thumb (smaller than Apple's native 51×31
  // because we have less vertical room in dense rows).
  const visual = (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-5 w-8 shrink-0 items-center rounded-full transition-colors',
        'bg-[var(--c-surface-2)] ring-hairline',
        'peer-checked:bg-[var(--c-action)] peer-checked:ring-[var(--c-action)]',
        'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--c-ring)] peer-focus-visible:ring-offset-2',
        'peer-focus-visible:ring-offset-[var(--c-bg)]',
        'peer-disabled:opacity-50',
        'peer-checked:[&>span]:translate-x-3',
      )}
    >
      <span className="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--c-surface)] shadow-sm transition-transform" />
    </span>
  );

  const native = (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      id={inputId}
      disabled={disabled}
      className="peer sr-only"
      aria-describedby={hintId}
      {...rest}
    />
  );

  if (label === undefined) {
    return (
      <span className={cn('inline-flex items-center', className)}>
        {native}
        {visual}
      </span>
    );
  }

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'press flex cursor-pointer items-center justify-between gap-3 rounded-[var(--r-utility)] py-2',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-body text-[var(--c-fg)]">{label}</span>
        {hint ? (
          <span id={hintId} className="text-label text-[var(--c-fg-muted)]">
            {hint}
          </span>
        ) : null}
      </span>
      {native}
      {visual}
    </label>
  );
});
