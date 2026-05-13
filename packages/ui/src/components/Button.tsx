import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { Spinner } from './Spinner';

const button = cva(
  [
    'press inline-flex items-center justify-center gap-2 font-medium select-none',
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
        danger:
          'bg-[var(--c-danger)] text-[var(--c-fg-inverse)] rounded-[var(--r-pill)]',
        pearl:
          'bg-[var(--c-surface-2)] text-[var(--c-fg)] rounded-[var(--r-capsule)] ring-hairline',
      },
      size: {
        // M2.4: sm pill text dropped to text-label (12) to match Badge +
        // Chip + Tab baseline. Was text-body-sm (13) which sat awkwardly
        // between the 12 px chip and 15 px Input. The 32 px height
        // (h-8) + 12 px text gives the same "compact secondary action"
        // rhythm as the RunPage history filter pill.
        sm: 'h-8 px-3 text-label',
        md: 'h-11 px-5 text-h3',
        lg: 'h-14 px-7 text-h2',
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
      <span>{children}</span>
      {trailingIcon}
    </button>
  );
});
