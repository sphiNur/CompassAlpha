import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface PageProps {
  children: ReactNode;
  /** The screen's pinned actions; see ActionBar. */
  actions?: ReactNode;
  className?: string;
}

/**
 * A screen: paper background, 20px side margins, 24px between sections,
 * and the action bar pinned under the scrolling content.
 */
export function Page({ children, actions, className }: PageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral text-body text-ink">
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-xl overflow-y-auto overscroll-contain px-page py-xl',
          className,
        )}
      >
        {children}
      </div>
      {actions}
    </div>
  );
}

export interface SectionProps {
  /** Names the group. Leave out when the content needs no name. */
  title?: string;
  /** Right of the title: a total or a count for the group. */
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A named group of content within a page. */
export function Section({ title, summary, children, className }: SectionProps) {
  return (
    <section className={cn('flex flex-col gap-sm', className)}>
      {title || summary ? (
        <div className="flex items-baseline justify-between gap-lg">
          {title ? <h2 className="min-w-0 text-h2 text-ink">{title}</h2> : <span />}
          {summary ? <span className="shrink-0">{summary}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface ActionBarProps {
  /** One line above the button: the total being committed, or what is missing. */
  summary?: ReactNode;
  /** The screen's primary Button, optionally preceded by one secondary. */
  children: ReactNode;
  className?: string;
}

/**
 * Where a screen's main action lives: pinned to the bottom, within reach
 * of a thumb, above the navigation.
 */
export function ActionBar({ summary, children, className }: ActionBarProps) {
  return (
    <div
      data-testid="action-bar"
      className={cn(
        'flex shrink-0 flex-col gap-sm bg-surface px-page py-lg shadow-raised',
        className,
      )}
    >
      {summary ? <div className="flex items-baseline justify-between gap-lg">{summary}</div> : null}
      {children}
    </div>
  );
}
