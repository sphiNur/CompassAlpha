import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: 'info' | 'success' | 'warn' | 'danger';
  /** ReactNode title override — wider type than the native string `title` attribute. */
  title?: ReactNode;
  action?: ReactNode;
}

const TONE: Record<NonNullable<BannerProps['tone']>, string> = {
  info: 'bg-[var(--c-surface-2)] text-[var(--c-fg)] ring-hairline',
  success: 'bg-[oklch(96%_0.06_145)] text-[oklch(35%_0.16_145)]',
  warn: 'bg-[oklch(97%_0.07_75)] text-[oklch(35%_0.16_75)]',
  danger: 'bg-[oklch(96%_0.06_25)] text-[var(--c-danger)]',
};

export function Banner({ className, tone = 'info', title, action, children, ...rest }: BannerProps) {
  return (
    <div
      role="status"
      // M3.16 (2026-05-16): py-3 → py-2.5. Most banners (the "How
      // permissions work" explainer on Roles, the "已通过·等待采购"
      // success on Order, etc.) sit above content lists and were
      // eating ~7% of viewport on a 5.5" device.
      className={cn('flex items-start gap-3 rounded-[var(--r-card)] px-4 py-2.5', TONE[tone], className)}
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
