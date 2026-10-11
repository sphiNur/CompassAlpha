/** @type {import('tailwindcss').Config} */
import designTokens from '@compass/ui/tailwind-preset';

/**
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
 *     line-height. NO baked weight, NO baked tracking. If a caller wants
 *     an 11px-uppercase-bold-spaced LABEL, they write
 *     `className="text-label font-semibold uppercase tracking-eyebrow"`
 *     — opt-in, explicit, locally readable.
 *
 * Sizes (keep in sync with packages/ui/src/tokens.css):
 *   display 24 · h1 19 · h2 15 · h3 14 · body 13 · body-sm 12 ·
 *   label 11 · meta 10 (deprecated) · tiny 9
 */
const fontSizeScale = {
  // The old components, at Fine's sizes until each is rebuilt: the old
  // scale ran from 9 to 13px, which is the density that was complained
  // about. Nothing is under Fine's caption size now. See the block at the
  // end of packages/ui/src/tokens.css.
  'old-display': ['28px', { lineHeight: '1.15', letterSpacing: '0', fontWeight: '700' }],
  'old-h1': ['28px', { lineHeight: '1.2', letterSpacing: '0', fontWeight: '700' }],
  'old-h2': ['22px', { lineHeight: '1.25', fontWeight: '600' }],
  'old-h3': ['16px', { lineHeight: '1.4' }],
  'old-body': ['16px', { lineHeight: '1.5' }],
  'old-body-sm': ['14px', { lineHeight: '1.45' }],
  'old-label': ['13px', { lineHeight: '1.4' }],
  'old-meta': ['13px', { lineHeight: '1.4' }],
  'old-tiny': ['13px', { lineHeight: '1.4' }],
};

export default {
  // The redesign's tokens (DESIGN.md). Screens that have been rebuilt use
  // only these; the `old-*` scale below goes away with the last old screen.
  presets: [designTokens],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontSize: fontSizeScale,
      letterSpacing: {
        // M1.9-extra (2026-05-07): "eyebrow" labels — caps-set
        // semantic markers above sections/tiles. The 0.08em spacing
        // was repeated in 18 ad-hoc `tracking-[0.08em]` arbitrary
        // utilities. Promoting to a token: `tracking-eyebrow`.
        eyebrow: '0.08em',
      },
    },
  },
  plugins: [],
};
