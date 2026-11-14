import { useEffect } from 'react';
import { ANNOUNCE_DELAY_MS, useUiAnnounce } from '../announce';
import { cn } from '../cn';
import { useUiLabels } from '../labels';
import { Spinner } from './Spinner';

/**
 * A loading state on its own (review UI-13, 2026-11-11). DataState's
 * spinner said nothing to a screen reader (Spinner is aria-hidden), so
 * pages re-made the block with `role="status"`, each with its own
 * padding (py-4 / 6 / 8 / 12), or wrote "spinner + Loading roles…" by
 * hand, and most spinners said nothing at all.
 *
 *   - block    a page's or a sheet's content while it loads (DataState's).
 *   - compact  a section inside a card or a sheet.
 *   - inline   a line in a form, with the words beside the spinner
 *              ("Loading roles…").
 *
 * `label` defaults to the kit's "Loading…". The block and compact
 * variants show it to a screen reader only; inline shows it.
 *
 * Review MWB-09 (modern-web-guidance: spinner): the block used to be a
 * `role="status"` region that mounted already holding its text, and "a
 * region that arrives with its text is often not read". The text stays
 * in place (plain text, found when reading the page), and the words are
 * said once through the host's one polite announcer, after
 * ANNOUNCE_DELAY_MS, so a quick load says nothing. Several states that
 * appear together (sections of one page) say it once. `announce={false}`
 * for a copy nobody should hear (the swipe pager's hidden neighbour).
 */
export type LoadingStateVariant = 'block' | 'compact' | 'inline';

export interface LoadingStateProps {
  variant?: LoadingStateVariant;
  label?: string;
  className?: string;
  /** Say the label through the host's announcer once it has stood a moment (default true). */
  announce?: boolean;
}

/** The last loading text said, and when (ms): one voice for states that appear together. */
let lastSaid: { text: string; at: number } | null = null;

/** States that appear within this window of each other say their text once. */
export const LOADING_REPEAT_MS = 2000;

/** Whether `text` should be said at `now`, given what was said last. Pure; exported for tests. */
export function shouldSayLoading(
  last: { text: string; at: number } | null,
  text: string,
  now: number,
): boolean {
  if (!text) return false;
  return !last || last.text !== text || now - last.at >= LOADING_REPEAT_MS;
}

function useSayLoading(text: string, enabled: boolean): void {
  const say = useUiAnnounce();
  useEffect(() => {
    if (!enabled) return;
    const said = text.trim();
    const timer = setTimeout(() => {
      const now = Date.now();
      if (!shouldSayLoading(lastSaid, said, now)) return;
      lastSaid = { text: said, at: now };
      say(said);
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, enabled, say]);
}

export function LoadingState({
  variant = 'block',
  label,
  className,
  announce = true,
}: LoadingStateProps) {
  const labels = useUiLabels();
  const text = label ?? labels.loading;
  useSayLoading(text, announce);
  if (variant === 'inline') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 text-old-body-sm text-[var(--c-fg-muted)]',
          className,
        )}
      >
        <Spinner size={14} />
        {text}
      </div>
    );
  }
  const compact = variant === 'compact';
  return (
    <div
      className={cn(
        'flex items-center justify-center text-[var(--c-fg-muted)]',
        compact ? 'py-6' : 'py-12',
        className,
      )}
    >
      <Spinner size={compact ? 16 : 28} />
      <span className="sr-only">{text}</span>
    </div>
  );
}
