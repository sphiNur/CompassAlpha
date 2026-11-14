import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: 'info' | 'success' | 'warn' | 'danger';
  /** ReactNode title override — wider type than the native string `title` attribute. */
  title?: ReactNode;
  action?: ReactNode;
}

/** The live-region role a banner of this tone gets. Exported for tests. */
export function bannerRole(tone: NonNullable<BannerProps['tone']>): 'alert' | 'status' {
  return tone === 'danger' ? 'alert' : 'status';
}

const TONE: Record<NonNullable<BannerProps['tone']>, string> = {
  info: 'bg-[var(--c-surface-2)] text-[var(--c-fg)]',
  // V7: status tints and inks are tokens so they follow the dark theme.
  success: 'bg-[var(--c-success-bg)] text-[var(--c-success-ink)]',
  warn: 'bg-[var(--c-warn-bg)] text-[var(--c-warn-ink)]',
  danger: 'bg-[var(--c-danger-bg)] text-[var(--c-danger-ink)]',
};

export function Banner({ className, tone = 'info', title, action, children, ...rest }: BannerProps) {
  return (
    <div
      // Review UI-22 (2026-11-12): a danger banner (a failed load, a
      // refused action) is an alert, read out at once, also when it
      // arrives with its text (a polite status often is not). Every
      // other tone stays a status; a caller's `role` wins.
      role={bannerRole(tone)}
      // UI overhaul A2 (2026-11-15): every tone is a tint with no
      // outline (info had a hairline: a box drawn on a box), and the
      // padding is the card's 16/12, on the 4-step scale.
      className={cn('flex items-start gap-3 rounded-[var(--r-card)] px-4 py-3', TONE[tone], className)}
      {...rest}
    >
      {/* 2026-11-05: min-w-0 + break-words — a long word (a ru/uz product
          or store name) wrapped instead of pushing the action off the edge. */}
      <div className="min-w-0 flex-1 break-words">
        {title ? <div className="text-old-h3 font-semibold">{title}</div> : null}
        {/* Review MWC-10 (V9): pretty, not balance: a banner has a visible box. */}
        {children ? (
          <div className="text-old-body-sm opacity-90 [text-wrap:pretty]">{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
