import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

// Capsule pass (2026-07-31): Badge is the micro capsule — fixed h-5
// (20px = 5/8 U on the size ladder) instead of the py-wiggle height,
// borderless fills only. Neutral tones use the translucent --c-capsule
// fill (Telegram chrome look); status tones use the --c-*-bg tints
// with their measured *-fg inks — the raw oklch literals that lived
// here (and drifted against Banner's and Toast's copies, and had no
// dark-theme override) are gone per UI-8.
const badge = cva(
  'inline-flex h-5 items-center gap-1 rounded-[var(--r-pill)] px-2 text-label font-medium',
  {
    variants: {
      tone: {
        info: 'bg-[var(--c-capsule)] text-[var(--c-fg-muted)]',
        success: 'bg-[var(--c-success-bg)] text-[var(--c-success-fg)]',
        warn: 'bg-[var(--c-warn-bg)] text-[var(--c-warning-fg)]',
        danger: 'bg-[var(--c-danger-bg)] text-[var(--c-danger-fg)]',
        action: 'bg-[var(--c-action)] text-[var(--c-action-fg)]',
        muted: 'bg-[var(--c-capsule)] text-[var(--c-fg-subtle)]',
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
