/**
 * The design tokens in DESIGN.md, as a Tailwind preset.
 *
 * DESIGN.md at the repository root is the source. This file restates its
 * `colors`, `typography`, `rounded` and `spacing` blocks, plus the fixed
 * heights its `components` block names, and src/kit/__tests__/tokens.test.ts
 * fails when the two disagree. Change the document first, then this.
 *
 * Nothing outside these scales belongs in a rebuilt screen: no arbitrary
 * `text-[13px]`, no `p-[18px]`.
 */
export const colors = {
  primary: '#0F6B4F',
  'primary-pressed': '#0B523C',
  'on-primary': '#FFFFFF',
  ink: '#111827',
  secondary: '#6B7280',
  neutral: '#FAFAF8',
  surface: '#FFFFFF',
  'surface-sunken': '#F2F1ED',
  line: '#E8E6E2',
  success: '#0F6B4F',
  warning: '#B4762A',
  'warning-ink': '#8A5A1C',
  danger: '#B3261E',
  info: '#2A5B9B',
};

export const typography = {
  display: {
    fontSize: '2rem',
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: '-0.02em',
    tnum: true,
  },
  h1: { fontSize: '1.5rem', fontWeight: 650, lineHeight: 1.25, letterSpacing: '-0.01em' },
  h2: { fontSize: '1.125rem', fontWeight: 600, lineHeight: 1.3 },
  body: { fontSize: '1rem', fontWeight: 400, lineHeight: 1.5 },
  label: { fontSize: '0.9375rem', fontWeight: 550, lineHeight: 1.4 },
  caption: { fontSize: '0.8125rem', fontWeight: 500, lineHeight: 1.35, letterSpacing: '0.01em' },
  money: { fontSize: '1rem', fontWeight: 650, lineHeight: 1.2, tnum: true },
  'money-lg': { fontSize: '1.5rem', fontWeight: 700, lineHeight: 1.15, tnum: true },
};

export const rounded = { sm: '10px', md: '14px', lg: '20px', pill: '999px' };

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  page: '20px',
  xl: '24px',
  xxl: '32px',
  xxxl: '48px',
};

/** Fixed heights from the `components` block: touch target, button, row. */
export const sizes = { tap: '44px', control: '52px', row: '56px' };

const fontSize = Object.fromEntries(
  Object.entries(typography).map(([name, t]) => [
    name,
    [
      t.fontSize,
      {
        lineHeight: String(t.lineHeight),
        fontWeight: String(t.fontWeight),
        ...(t.letterSpacing ? { letterSpacing: t.letterSpacing } : {}),
      },
    ],
  ]),
);

const tabular = Object.fromEntries(
  Object.entries(typography)
    .filter(([, t]) => t.tnum)
    .map(([name]) => [`.text-${name}`, { 'font-variant-numeric': 'tabular-nums' }]),
);

/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors,
      fontSize,
      borderRadius: rounded,
      spacing: { ...spacing, ...sizes },
      boxShadow: {
        // The one shadow the design allows: under a sheet or a pinned
        // action bar, to separate it from content scrolling beneath.
        raised: '0 -1px 0 #E8E6E2, 0 -6px 20px rgb(17 24 39 / 0.06)',
      },
    },
  },
  plugins: [
    // A column of amounts only scans when every digit is the same width.
    ({ addUtilities }) => addUtilities(tabular),
  ],
};
