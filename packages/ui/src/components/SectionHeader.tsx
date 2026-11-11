import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface SectionHeaderProps {
  title: ReactNode;
  /** A line under the title. */
  subtitle?: ReactNode;
  /**
   * The in-page way back. Leave it out where the host has its own (the
   * Telegram BackButton) or where there is nowhere to go back to.
   */
  back?: { label: ReactNode; ariaLabel?: string; onBack: () => void };
  className?: string;
}

/**
 * The header of a drill-in screen (UI_STANDARDS UI-12): an optional back
 * link, then the screen's one 19 px semibold `<h1>`. The title takes
 * focus (tabIndex -1) when a host moves focus to the opened screen. A
 * bottom-nav tab page has no header: the nav names it and the Shell
 * renders a hidden `<h1>`.
 *
 * Review UI-14 (2026-11-11): the kit had only PageHeader, a visible title
 * for tab pages, which UI-12 rules out. The drill-in header was written
 * out by hand in the admin sections, the finance-only admin view and the
 * debug console.
 */
export function SectionHeader({ title, subtitle, back, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      {back ? (
        <div className="flex items-center gap-2 px-2 pb-2 pt-3">
          <button
            type="button"
            onClick={back.onBack}
            aria-label={back.ariaLabel}
            className="press hit-44 inline-flex h-9 items-center gap-1 rounded-[var(--r-pill)] px-3 text-old-body text-[var(--c-action)]"
          >
            <span aria-hidden className="text-old-h2 leading-none">
              ‹
            </span>
            <span>{back.label}</span>
          </button>
        </div>
      ) : null}
      <div className="px-4 pb-2 pt-3">
        <h1
          tabIndex={-1}
          className="text-old-h1 font-semibold leading-[1.15] text-[var(--c-fg)] outline-none"
        >
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-0.5 text-old-body-sm text-[var(--c-fg-muted)]">{subtitle}</p>
        ) : null}
      </div>
    </div>
  );
}
