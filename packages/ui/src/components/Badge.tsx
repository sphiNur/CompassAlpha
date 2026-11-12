import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

const badge = cva(
  'inline-flex items-center gap-1 rounded-[var(--r-pill)] px-2.5 py-0.5 text-old-label font-medium',
  {
    variants: {
      tone: {
        info: 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)] ring-hairline',
        success: 'bg-[var(--c-success-bg)] text-[var(--c-success-ink)]',
        warn: 'bg-[var(--c-warn-bg)] text-[var(--c-warn-ink)]',
        danger: 'bg-[var(--c-danger-bg)] text-[var(--c-danger-ink)]',
        action: 'bg-[var(--c-action)] text-[var(--c-action-fg)]',
        muted: 'bg-transparent text-[var(--c-fg-subtle)] ring-hairline',
      },
    },
    defaultVariants: { tone: 'info' },
  },
);

/**
 * A status pill. The caller passes the words, already localized (UI-2),
 * and picks the tone. Review UI-19 (2026-11-12): a `status` prop that
 * chose the tone from a status enum, and showed the raw enum ("rejected")
 * when no words were given, is gone; no page used it.
 */
export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>;

export function Badge({ className, tone, children, ...rest }: BadgeProps) {
  return (
    <span className={cn(badge({ tone }), className)} {...rest}>
      {children}
    </span>
  );
}
