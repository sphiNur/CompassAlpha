import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` is the screen's one main action; a screen never shows two.
   * `ghost` is for actions that write nothing (back, cancel). `danger`
   * belongs inside a confirming sheet.
   */
  variant?: ButtonVariant;
  /** A request is in flight: the button holds its label and ignores taps. */
  busy?: boolean;
  /** Size to the label instead of filling the row. */
  inline?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'h-control bg-primary text-on-primary active:bg-primary-pressed',
  secondary: 'h-control bg-surface-sunken text-ink active:bg-line',
  ghost: 'h-tap text-ink active:bg-surface-sunken',
  danger: 'h-control bg-danger text-on-danger active:opacity-90',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', busy = false, inline = false, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(
        'flex min-w-0 select-none items-center justify-center rounded-pill px-xl text-label',
        'outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2',
        // Disabled keeps its shape and place; only the ink recedes.
        'disabled:bg-surface-sunken disabled:text-secondary',
        inline ? 'inline-flex' : 'w-full',
        VARIANT[variant],
        busy && 'animate-pulse',
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
});
