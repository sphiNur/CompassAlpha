import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * SectionLabel — the standardised eyebrow row for grouping cards or
 * heading nested sub-sections.
 *
 * Added 2026-05-08 (M2.1) to replace ~10 ad-hoc divs scattered across
 * pages that all rendered the same thing slightly differently. Audit in
 * M3.13 found 24 MORE inline sites that bypassed the primitive — they
 * each had the same class string but inconsistent surrounding markup
 * (`<h3 mb-2>`, `<div>`, `<span>`, etc.) and small spacing drift.
 * M3.13 extends the primitive so those sites can migrate without
 * losing their semantics.
 *
 *   <SectionLabel>Items</SectionLabel>                  -- default
 *   <SectionLabel meta={`${done}/${total}`}>Items</SectionLabel>
 *
 *   <SectionLabel as="h3" padded={false} className="mb-2">
 *     🏪 Store
 *   </SectionLabel>
 *
 * Visual rules (read these BEFORE customising):
 *
 *   - Text size: `text-label` (11 px — see --text-label in tokens.css;
 *     this comment said 12 px, which stopped being true at M3.14 and is
 *     exactly the drift this component exists to prevent) — small
 *     enough to feel like
 *     metadata, not a heading.
 *   - Color: `--c-fg-muted` (default `muted` tone) — keeps it visually
 *     lower than card titles which sit at text-h2 / --c-fg. Use
 *     `tone="strong"` only when the section needs the eyebrow to read
 *     as a header without a CardTitle above it.
 *   - Casing: UPPERCASE with `tracking-eyebrow` for the eyebrow effect.
 *     Strong differentiation from regular sentence-case body copy.
 *   - Padding (default): `px-4 py-1.5` — matches the rhythm of cards
 *     when grouped with `flex flex-col gap-2`. Set `padded={false}`
 *     when this lives INSIDE a card or already-padded section so the
 *     spacing doesn't double up.
 *   - Element: defaults to `<div>`. Use `as="h2"` / `as="h3"` for
 *     screen-reader correctness when this heads a nested semantic
 *     section.
 *
 * Why a dedicated component (vs Tailwind utility classes inlined):
 *
 *   - Single source of truth for the eyebrow style → easy to retune
 *     site-wide if we ever want to e.g. drop the uppercase.
 *   - Type-safe `meta` slot — encourages right-aligned counters
 *     instead of operators inventing ad-hoc layouts for them.
 *   - Searchability — grepping for `<SectionLabel>` finds every
 *     section grouping; grepping for the raw class string finds
 *     nothing.
 *   - A grep-based CI check (M3.13) bans the raw class string outside
 *     this file so the inline pattern can't sneak back in.
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
  /** Optional extra classes for one-off positioning (e.g. `mb-2`). */
  className?: string;
  /**
   * M3.13 (2026-05-16): semantic element. Default `'div'`. Switch to
   * `'h2'` / `'h3'` when the label heads a screen-reader-discoverable
   * section. Has no visual effect — only the role exposed to AT.
   *
   * 2026-07-30: `'h1'` added. A page whose card header IS its title
   * (history-as-a-tab) had no way to say so — the choice was an
   * `<h2>` with no `<h1>` above it, or a duplicate visible title just
   * to own the h1. Still no visual effect.
   */
  as?: 'div' | 'h1' | 'h2' | 'h3';
  /**
   * M3.13 (2026-05-16): controls the `px-4 py-1.5` padding. When the
   * label sits inside an already-padded container (Card body, Sheet
   * body, etc.), pass `false` to drop the padding so the spacing
   * doesn't compound. Default `true`.
   */
  padded?: boolean;
}

export function SectionLabel({
  children,
  meta,
  tone = 'muted',
  className,
  as = 'div',
  padded = true,
}: SectionLabelProps) {
  const color = tone === 'strong' ? 'text-[var(--c-fg)]' : 'text-[var(--c-fg-muted)]';
  const layout = padded
    ? 'flex items-baseline justify-between gap-2 px-4 py-1.5'
    : 'flex items-baseline justify-between gap-2';
  // Polymorphic element. JSX accepts a tag-name string as a Component;
  // the resulting cast keeps TS happy without requiring per-tag prop
  // forwarding (we don't need refs into a SectionLabel).
  const Tag = as;
  return (
    <Tag
      className={cn(
        layout,
        'text-label font-semibold uppercase tracking-eyebrow',
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
    </Tag>
  );
}
