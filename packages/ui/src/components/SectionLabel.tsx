import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * SectionLabel — the standardised eyebrow row for grouping cards.
 * Added 2026-05-08 (M2.1) to replace ~10+ ad-hoc divs scattered
 * across pages that all rendered the same thing slightly differently:
 *
 *   <div className="text-label font-semibold uppercase tracking-wide
 *                   text-[var(--c-fg-muted)]">
 *     Items
 *   </div>
 *
 * With this primitive:
 *
 *   <SectionLabel>{i18n.t('run.section.items')}</SectionLabel>
 *
 * Optional `meta` slot for a right-aligned counter / fraction / link:
 *
 *   <SectionLabel meta={`${done}/${total}`}>Items</SectionLabel>
 *
 * Visual rules (read these BEFORE customising):
 *
 *   - Text size: `text-label` (12 px) — small enough to feel like
 *     metadata, not a heading.
 *   - Color: `--c-fg-muted` — keeps it visually lower than card
 *     titles (which sit at text-h3 / --c-fg).
 *   - Casing: UPPERCASE with `tracking-wide` for the eyebrow effect.
 *     Strong differentiation from regular sentence-case body copy.
 *   - Padding: `px-4 py-1.5` — matches the rhythm of the cards it
 *     sits above when grouped with `flex flex-col gap-2`.
 *
 * Why a dedicated component (vs Tailwind utility classes inlined):
 *
 *   - Single source of truth for the eyebrow style → easy to retune
 *     site-wide if we ever want to e.g. drop the uppercase.
 *   - Type-safe meta slot — encourages right-aligned counters
 *     instead of operators inventing ad-hoc layouts for them.
 *   - Searchability — grepping for `<SectionLabel>` finds every
 *     section grouping; grepping for the raw class string finds
 *     nothing.
 */
export interface SectionLabelProps {
  /** Main label text — usually a noun phrase like "Items" / "Stores". */
  children: ReactNode;
  /** Optional right-aligned auxiliary text (e.g. "5/12"). */
  meta?: ReactNode;
  /** Tone modifier. `muted` (default) for the standard eyebrow,
   *  `strong` when the section needs more weight (rare — usually
   *  the card title carries the weight). */
  tone?: 'muted' | 'strong';
  /** Optional extra classes for one-off positioning. */
  className?: string;
}

export function SectionLabel({
  children,
  meta,
  tone = 'muted',
  className,
}: SectionLabelProps) {
  const color = tone === 'strong' ? 'text-[var(--c-fg)]' : 'text-[var(--c-fg-muted)]';
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-2 px-4 py-1.5 text-label font-semibold uppercase tracking-wide',
        color,
        className,
      )}
    >
      <span className="truncate">{children}</span>
      {meta ? (
        <span className="shrink-0 font-normal tabular-nums text-[var(--c-fg-muted)]">
          {meta}
        </span>
      ) : null}
    </div>
  );
}
