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
        secondary:
          'bg-[var(--c-surface-2)] text-[var(--c-fg)] rounded-[var(--r-pill)] ring-hairline',
        ghost:
          'bg-transparent text-[var(--c-action)] rounded-[var(--r-pill)]',
        utility:
          'bg-[var(--c-fg)] text-[var(--c-fg-inverse)] rounded-[var(--r-utility)]',
        // Filled red — for irreversible PRIMARY destructive actions
        // (delete account, drop org). Heavy by design.
        danger:
          'bg-[var(--c-danger)] text-[var(--c-fg-inverse)] rounded-[var(--r-pill)]',
        // M3.16 (2026-05-16): "soft danger" — transparent with red
        // text + red hairline. Right tone for SECONDARY destructive
        // operations (archive a category, archive a SKU) where the
        // PRIMARY action sitting next to it is "Edit". Filled-danger
        // was outweighing Edit in admin lists and pulling the user's
        // eye to the dangerous button.
        'danger-ghost':
          'bg-transparent text-[var(--c-danger)] rounded-[var(--r-pill)] ring-1 ring-[var(--c-danger)]/40',
        pearl:
          'bg-[var(--c-surface-2)] text-[var(--c-fg)] rounded-[var(--r-capsule)] ring-hairline',
      },
      size: {
        // M2.4 (text), M3.15 (heights, 2026-05-16):
        //   - sm: h-8 (32) + text-label (11) — compact secondary actions.
        //   - md: h-10 (40, was 44) + text-h3 (14) — default form / inline
        //     actions. -4 px brings the row rhythm closer to the bottom
        //     nav (icons + label = ~36 px tall).
        //   - lg: h-13 (52, was 56) + text-h3 (14, was text-h2 / 15) —
        //     sheet-footer commits + page-bottom CTAs. Big enough to
        //     anchor the action without towering over the 64 px nav.
        sm: 'h-8 px-3 text-label',
        md: 'h-10 px-5 text-h3',
        // h-[52px] — Tailwind's scale jumps 12→14 (48→56), and we want
        // exactly the middle.
        lg: 'h-[52px] px-7 text-h3',
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
