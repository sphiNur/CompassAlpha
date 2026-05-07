import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

const badge = cva(
  'inline-flex items-center gap-1 rounded-[var(--r-pill)] px-2.5 py-0.5 text-label font-medium',
  {
    variants: {
      tone: {
        info: 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)] ring-hairline',
        success: 'bg-[oklch(95%_0.06_145)] text-[var(--c-success)]',
        warn: 'bg-[oklch(96%_0.07_75)] text-[oklch(40%_0.16_75)]',
        danger: 'bg-[oklch(96%_0.06_25)] text-[var(--c-danger)]',
        action: 'bg-[var(--c-action)] text-[var(--c-action-fg)]',
        muted: 'bg-transparent text-[var(--c-fg-subtle)] ring-hairline',
      },
    },
    defaultVariants: { tone: 'info' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {
  status?: string;
}

const STATUS_TO_TONE: Record<string, BadgeProps['tone']> = {
  draft: 'muted',
  submitted: 'info',
  approved: 'success',
  rejected: 'danger',
  in_run: 'action',
  archived: 'muted',
  planned: 'info',
  purchasing: 'action',
  delivering: 'action',
  finished: 'success',
  cancelled: 'danger',
};

export function Badge({ className, tone, status, children, ...rest }: BadgeProps) {
  const resolvedTone: BadgeProps['tone'] =
    tone ?? (status ? STATUS_TO_TONE[status] ?? 'info' : 'info');
  return (
    <span className={cn(badge({ tone: resolvedTone }), className)} {...rest}>
      {children ?? status}
    </span>
  );
}
