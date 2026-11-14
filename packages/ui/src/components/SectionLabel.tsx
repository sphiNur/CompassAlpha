import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * SectionLabel — the standard heading row for grouping cards or
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
 *     Store
 *   </SectionLabel>
 *
 * Visual rules (read these BEFORE customising):
 *
 *   - Text: `text-old-body font-semibold` (13 px), sentence case
 *     (UI_STANDARDS UI-11). Nothing is uppercase: it means nothing in
 *     Chinese and reads badly in Russian and Uzbek.
 *   - Color: `--c-fg-muted` (default `muted` tone) — keeps it visually
 *     lower than card titles which sit at text-old-h2 / --c-fg. Use
 *     `tone="strong"` only when the section needs the label to read
 *     as a header without a CardTitle above it.
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
 *   - Single source of truth for the heading style → easy to retune
 *     site-wide.
 *   - Type-safe `meta` slot — encourages right-aligned counters
 *     instead of operators inventing ad-hoc layouts for them.
 *   - Searchability — grepping for `<SectionLabel>` finds every
 *     section grouping; grepping for the raw class string finds
 *     nothing.
 *   - CI's typography guard fails on any `uppercase` class, so the old
 *     hand-rolled eyebrow cannot come back (review UI-17: this said a
 *     CI check banned the raw class string; there is no such check).
 */
export interface SectionLabelProps {
  /** Main label text — usually a noun phrase like "Items" / "Stores". */
  children: ReactNode;
  /** Optional right-aligned auxiliary text (e.g. "5/12"). */
  meta?: ReactNode;
  /** Tone modifier. `muted` (default) for the standard heading,
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
  // DX-HIS-4 (2026-11-01): the row wraps. The meta used to be shrink-0
  // next to a truncating title, so at 360 px a long meta ("39 trips ·
  // 118,112,379.90 UZS (total of …)") squeezed the page heading to a
  // single dot, and in ru / uz ran past the card edge. Now the meta drops
  // to its own line and wraps there; the title keeps the first line.
  const layout = padded
    ? 'flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 px-4 py-1.5'
    : 'flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5';
  // Polymorphic element. JSX accepts a tag-name string as a Component;
  // the resulting cast keeps TS happy without requiring per-tag prop
  // forwarding (we don't need refs into a SectionLabel).
  const Tag = as;
  return (
    <Tag
      className={cn(
        layout,
        'text-old-body font-semibold',
        color,
        className,
      )}
    >
      {/* Review MWC-09 (modern-web-guidance: form-factor-adaptation): "DO
          NOT truncate headings with text-overflow: ellipsis". A long ru /
          uz title wraps to two balanced lines; a short one is unchanged. */}
      <span className="min-w-0 max-w-full break-words line-clamp-2 [text-wrap:balance]">
        {children}
      </span>
      {meta ? (
        <span className="min-w-0 break-words text-old-label font-normal tabular-nums text-[var(--c-fg-muted)]">
          {meta}
        </span>
      ) : null}
    </Tag>
  );
}
