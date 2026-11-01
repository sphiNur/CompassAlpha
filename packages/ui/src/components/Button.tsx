import { forwardRef, isValidElement, useRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { Spinner } from './Spinner';
import { createTapGuard } from '../useTapGuard';

const button = cva(
  [
    // V4 (2026-10-30): hit-44 gives sm (32) and md (40) a 44 px tap area
    // without changing how they look. That needs the button NOT to clip
    // its overflow (a clipped ::after takes no taps); the label span
    // below truncates itself instead.
    'press hit-44 inline-flex min-w-0 max-w-full items-center justify-center gap-2 font-medium select-none',
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
          'bg-[var(--c-danger)] text-[var(--c-danger-fg)] rounded-[var(--r-pill)]',
        // M3.16 (2026-05-16): "soft danger" — transparent with red
        // text + red hairline. Right tone for SECONDARY destructive
        // operations (archive a category, archive a SKU) where the
        // PRIMARY action sitting next to it is "Edit". Filled-danger
        // was outweighing Edit in admin lists and pulling the user's
        // eye to the dangerous button.
        'danger-ghost':
          'bg-transparent text-[var(--c-danger)] rounded-[var(--r-pill)] ring-1 ring-[color:color-mix(in_oklch,var(--c-danger)_40%,transparent)]',
        pearl:
          'bg-[var(--c-surface-2)] text-[var(--c-fg)] rounded-[var(--r-capsule)] ring-hairline',
      },
      size: {
        // M2.4 (text), M3.15 (heights, 2026-05-16):
        //   - sm: h-8 (32) + text-old-label (11) — compact secondary actions.
        //   - md: --control-h (44 since D18, 2026-10-31; 40 before) +
        //     text-old-h3 (14) — default form / inline actions. Shares the
        //     text fields' height so an Input + Button row lines up.
        //   - lg: h-13 (52, was 56) + text-old-h3 (14, was text-old-h2 / 15) —
        //     sheet-footer commits + page-bottom CTAs. Big enough to
        //     anchor the action without towering over the 64 px nav.
        sm: 'h-8 px-3 text-old-label',
        md: 'h-[var(--control-h)] px-5 text-old-h3',
        // h-[52px] — Tailwind's scale jumps 12→14 (48→56), and we want
        // exactly the middle.
        lg: 'h-[52px] px-7 text-old-h3',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

/** A second tap on a write button within this window is a double tap. */
export const REPEAT_TAP_MS = 700;

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /**
   * The action's request is in flight: shows a spinner and disables the
   * button. Passing the prop at all (even `false`) also marks the button
   * as one that sends a write, so a quick second tap is dropped — see
   * REPEAT_TAP_MS.
   */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    block,
    loading,
    leadingIcon,
    trailingIcon,
    children,
    disabled,
    onClick,
    ...rest
  },
  ref,
) {
  const childIsPlain = typeof children === 'string' || typeof children === 'number';
  const tapGuard = useRef<ReturnType<typeof createTapGuard> | null>(null);
  // DLV-4 / BUY-12 (2026-10-30): `loading` disables the button only after
  // the re-render that follows the mutation starting, and React Query
  // reports isPending on a later tick — a double tap lands both clicks
  // first. "Start delivery" then sent two requests and showed success and
  // a conflict together. Every button that carries `loading` sends a
  // write, so it drops a repeat inside the window itself instead of each
  // call site remembering to wrap its handler.
  const guarded =
    loading === undefined || !onClick
      ? onClick
      : (e: MouseEvent<HTMLButtonElement>) => {
          tapGuard.current ??= createTapGuard(REPEAT_TAP_MS);
          if (!tapGuard.current.allow('', Date.now())) {
            e.preventDefault(); // a submit button must not submit twice either
            return;
          }
          onClick(e);
        };
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cn(button({ variant, size, block }), className)}
      {...rest}
      onClick={guarded}
    >
      {loading ? <Spinner size={16} /> : leadingIcon}
      <span className={childIsPlain || !isValidElement(children) ? 'min-w-0 truncate' : 'min-w-0'}>
        {children}
      </span>
      {trailingIcon}
    </button>
  );
});
