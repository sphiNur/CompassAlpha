import { forwardRef, isValidElement } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { Spinner } from './Spinner';

const button = cva(
  [
    'press inline-flex min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden font-medium select-none',
    'whitespace-nowrap outline-none transition-[background,color,box-shadow]',
    'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
    'focus-visible:ring-offset-[var(--c-ring-offset)]',
    'disabled:opacity-50 disabled:pointer-events-none',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--c-action)] text-[var(--c-action-fg)] hover:bg-[var(--c-action-hover)] rounded-[var(--r-pill)]',
        // 2026-07-31 (capsule pass): secondary = the Telegram chrome
        // capsule — translucent neutral fill, no hairline. Borders on
        // capsule controls are retired app-wide; the fill is the shape.
        secondary:
          'bg-[var(--c-capsule)] text-[var(--c-fg)] rounded-[var(--r-pill)]',
        ghost:
          'bg-transparent text-[var(--c-action)] rounded-[var(--r-pill)]',
        utility:
          'bg-[var(--c-fg)] text-[var(--c-fg-inverse)] rounded-[var(--r-utility)]',
        // Filled red — for irreversible PRIMARY destructive actions
        // (delete account, drop org). Heavy by design.
        danger:
          'bg-[var(--c-danger)] text-[var(--c-fg-inverse)] rounded-[var(--r-pill)]',
        // M3.16 (2026-05-16): "soft danger" — the right tone for
        // SECONDARY destructive operations (archive a category, archive
        // a SKU) where the PRIMARY action next to it is "Edit".
        // Filled-danger was outweighing Edit in admin lists and pulling
        // the user's eye to the dangerous button.
        //
        // 2026-07-31: was `ring-1 ring-[var(--c-danger)]/40` over a
        // transparent fill. Tailwind emits NO rule for an opacity
        // modifier on an arbitrary var() color, so the ring-COLOR class
        // resolved to nothing while `ring-1` still set a width — every
        // danger-ghost button in the admin lists has been rendering
        // Tailwind's default BLUE ring. Now a quiet danger-tinted
        // capsule, which fixes the color and matches UI-12 (controls
        // are filled, not outlined).
        'danger-ghost':
          'bg-[var(--c-danger-bg)] text-[var(--c-danger-fg)] rounded-[var(--r-pill)]',
        // Capsule pass: --r-capsule (12px) retired; pearl is now the
        // same borderless capsule as secondary. Kept as an alias so
        // call sites keep compiling — new code should say `secondary`.
        pearl:
          'bg-[var(--c-capsule)] text-[var(--c-fg)] rounded-[var(--r-pill)]',
      },
      size: {
        // Capsule-pass ladder (2026-07-31; see SIZE LADDER in tokens.css):
        //   - sm: capsule tier (32) + text-body-sm (12, the capsule type
        //     rule) — compact secondary actions, same rhythm as Chip/Tab.
        //   - md: field tier (40) + text-h3 (14) — default form / inline
        //     actions, lines up with Input/Select.
        //   - lg: CTA tier (48 = 3/2 U, was the off-ladder 52) + text-h3
        //     (14, M3.15 decision) — sheet-footer commits + page-bottom
        //     CTAs; same height as Shell's PageMainButton.
        sm: 'h-[var(--capsule-h)] px-3 text-body-sm',
        md: 'h-[var(--control-h)] px-5 text-h3',
        lg: 'h-[var(--control-h-lg)] px-6 text-h3',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, loading, leadingIcon, trailingIcon, children, disabled, ...rest },
  ref,
) {
  const childIsPlain = typeof children === 'string' || typeof children === 'number';
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cn(button({ variant, size, block }), className)}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : leadingIcon}
      <span className={childIsPlain || !isValidElement(children) ? 'min-w-0 truncate' : 'min-w-0'}>
        {children}
      </span>
      {trailingIcon}
    </button>
  );
});
