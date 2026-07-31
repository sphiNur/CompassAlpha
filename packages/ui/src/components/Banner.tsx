import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: 'info' | 'success' | 'warn' | 'danger';
  /** ReactNode title override — wider type than the native string `title` attribute. */
  title?: ReactNode;
  action?: ReactNode;
}

// Capsule pass (2026-07-31): raw oklch literals → token pairs (UI-8;
// the literals had no dark override and drifted against Badge's and
// Toast's copies of the same tints). info drops its hairline — a
// tinted/filled callout needs no border (UI-7), same as the other
// three tones never had one.
const TONE: Record<NonNullable<BannerProps['tone']>, string> = {
  info: 'bg-[var(--c-surface-2)] text-[var(--c-fg)]',
  success: 'bg-[var(--c-success-bg)] text-[var(--c-success-fg)]',
  warn: 'bg-[var(--c-warn-bg)] text-[var(--c-warning-fg)]',
  danger: 'bg-[var(--c-danger-bg)] text-[var(--c-danger-fg)]',
};

export function Banner({ className, tone = 'info', title, action, children, ...rest }: BannerProps) {
  return (
    <div
      role="status"
      // M3.16 (2026-05-16) trimmed the vertical padding here because
      // banners (the "How permissions work" explainer on Roles, the
      // "已通过·等待采购" success on Order) sit above content lists and
      // were eating ~7% of viewport on a 5.5" device. Capsule pass
      // (2026-07-31): that landed on py-2.5 = 10px, off the 4px grid;
      // py-2 keeps the trim and puts it back on the grid.
      className={cn('flex items-start gap-3 rounded-[var(--r-card)] px-4 py-2', TONE[tone], className)}
      {...rest}
    >
      <div className="flex-1">
        {title ? <div className="text-h3 font-semibold">{title}</div> : null}
        {children ? <div className="text-body-sm opacity-90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
