/**
 * The Tailwind theme the components need (review UI-15, 2026-11-10).
 *
 * Every component sizes its text with `text-old-*`, but the scale lived in
 * apps/web's tailwind.config.js, so another host had no sizes at all and a
 * cleanup of the app's config would have changed the library unseen. A
 * host adds this file to `presets` and lists packages/ui/src in its
 * `content`. The sheet animations and `.scrollbar-hide` are in tokens.css
 * for the same reason.
 *
 * Typography scale (M3.14, 2026-05-16 — shrink pass).
 *
 * Field feedback (2026-05-16): everything read ~20% bigger than intended
 * on the Android-heavy fleet Uzbek restaurants run. The earlier scale
 * (28/22/17/15/14/13/12/11/10) was tuned for iOS Telegram WebView; on
 * Android the DP-to-px ratio pushes type a tier up. Coordinated -1 to
 * -4px reduction keeps every role on its own line without collapsing
 * the hierarchy.
 *
 * Earlier rev (M1.7-fix4) baked `font-weight: 600` into body-tier
 * tokens; that got reverted then because every 12px caption + 15px
 * sub-row started looking like a shouty bolded label. We keep that
 * decision: weight stays caller-decided for h3 and below.
 *
 *   - Heading-tier (display / h1 / h2): bake font-weight + tight tracking
 *     because they're proper headings; the 600 + tightening is the whole
 *     point.
 *   - Everything else (h3, body, body-sm, label, meta, tiny): just size +
 *     line-height. NO baked weight, NO baked tracking; the caller picks
 *     the weight. Labels are sentence case: section headings are
 *     SectionLabel, form labels FieldLabel, and CI fails on `uppercase`
 *     (UI-11).
 *
 * The `old-` prefix is from when a redesign's larger scale held the
 * plain names. The owner kept the current look (2026-11-05) and that
 * scale is gone (review UI-16), so this is the one scale.
 *
 * Roles (docs/UI_STANDARDS.md):
 *
 *   page title                    text-old-h1, in SectionHeader    19px
 *   card / empty-state title      text-old-h2 semibold (CardTitle)  15px
 *   input value                   text-old-h3                       14px
 *   list-row primary, body copy   text-old-body                     13px
 *   section heading               SectionLabel: text-old-body
 *                                 semibold, sentence case (UI-11)   13px
 *   description, toast body       text-old-body-sm                  12px
 *   form label, meta, pills       text-old-label (FieldLabel for
 *                                 form labels; pills font-medium)   11px
 *   footnote                      text-old-tiny                      9px
 *   money                         the body font with tabular-nums,
 *                                 never font-mono (UI-14)
 *
 * Nothing is uppercase (the CI typography guard fails on it), so there
 * is no eyebrow style. Hierarchy comes from weight and the three inks
 * (--c-fg, --c-fg-muted, --c-fg-subtle) before size (UI_STANDARDS, core
 * principle). A screen that needs an exception says why in a one-line
 * comment. (Review UI-34, 2026-11-12: the roles moved here from
 * tokens.css, whose --text-* copies of these sizes had no reader.)
 *
 * Sizes (the names are registered with tailwind-merge in src/cn.ts, and
 * a test checks that):
 *   display 24 · h1 19 · h2 15 · h3 14 · body 13 · body-sm 12 ·
 *   label 11 · meta 10 (deprecated) · tiny 9
 */
export const FONT_SIZE_SCALE = {
  // Headings — bake weight + tracking (the whole semantic).
  'old-display': ['24px', { lineHeight: '1.15', letterSpacing: '0', fontWeight: '600' }],
  'old-h1': ['19px', { lineHeight: '1.2', letterSpacing: '0', fontWeight: '600' }],
  'old-h2': ['15px', { lineHeight: '1.25', fontWeight: '600' }],
  // Body and below — size + line-height only. Caller decides weight.
  'old-h3': ['14px', { lineHeight: '1.3' }],
  'old-body': ['13px', { lineHeight: '1.4' }],
  'old-body-sm': ['12px', { lineHeight: '1.4' }],
  'old-label': ['11px', { lineHeight: '1.3' }],
  'old-meta': ['10px', { lineHeight: '1.3' }],
  'old-tiny': ['9px', { lineHeight: '1.3' }],
};

/** @type {Partial<import('tailwindcss').Config>} */
export default {
  theme: {
    extend: {
      fontSize: FONT_SIZE_SCALE,
    },
  },
};
