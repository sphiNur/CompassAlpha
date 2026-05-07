/** @type {import('tailwindcss').Config} */

/**
 * Typography scale (M1.7-fix4, 2026-05-07 — hotfix after a too-aggressive
 * first pass).
 *
 * Earlier rev baked `font-weight: 600` + `letter-spacing` into body-tier
 * tokens (label/h3 in particular), turning every 12px caption + 15px
 * sub-row into a shouty bolded label. The user — correctly — called this
 * out as "messier than before". The sweep stays (329 sites converted to
 * tokens) but the SEMANTICS get re-tuned:
 *
 *   - Heading-tier (display / h1 / h2): bake font-weight + tight tracking
 *     because they're proper headings; the 600 + tightening is the whole
 *     point.
 *   - Everything else (h3, body, body-sm, label, meta, tiny): just size +
 *     line-height. NO baked weight, NO baked tracking. If a caller wants
 *     a 12px-uppercase-bold-spaced LABEL, they write
 *     `className="text-label font-semibold uppercase tracking-wide"` —
 *     opt-in, explicit, locally readable. Default 12px is just a small
 *     caption that inherits the surrounding weight.
 *
 * h3 demoted out of "heading" treatment because in this app most 15px
 * sites are SectionRow labels / button text — they want regular weight
 * unless explicitly bolded.
 */
const fontSizeScale = {
  // Headings — bake weight + tracking (the whole semantic).
  display: ['28px', { lineHeight: '1.15', letterSpacing: '-0.01em', fontWeight: '600' }],
  h1: ['22px', { lineHeight: '1.2', letterSpacing: '-0.01em', fontWeight: '600' }],
  h2: ['17px', { lineHeight: '1.25', fontWeight: '600' }],
  // Body and below — size + line-height only. Caller decides weight.
  h3: ['15px', { lineHeight: '1.3' }],
  body: ['14px', { lineHeight: '1.4' }],
  'body-sm': ['13px', { lineHeight: '1.4' }],
  label: ['12px', { lineHeight: '1.3' }],
  meta: ['11px', { lineHeight: '1.3' }],
  tiny: ['10px', { lineHeight: '1.3' }],
};

export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontSize: fontSizeScale,
    },
  },
  plugins: [],
};
