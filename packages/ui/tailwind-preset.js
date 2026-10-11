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
  primary: '#A3E635',
  'primary-pressed': '#8FD11F',
  'primary-pale': '#E4F7CC',
  'on-primary': '#10140B',
  forest: '#1F3A12',
  ink: '#10140B',
  secondary: '#454745',
  neutral: '#EBEEE7',
  surface: '#FFFFFF',
  'surface-sunken': '#DEE3D8',
  line: '#D5D9D0',
  success: '#2EAD4B',
  warning: '#FFD11A',
  'warning-pale': '#FFF1B8',
  'warning-ink': '#4A3B1C',
  danger: '#C8322F',
  'danger-pale': '#FBE1DF',
  'danger-ink': '#8E1F1C',
  'on-danger': '#FFFFFF',
};

export const typography = {
  display: {
    fontSize: '2rem',
    fontWeight: 900,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    tnum: true,
  },
  h1: { fontSize: '1.75rem', fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.03em' },
  h2: { fontSize: '1.25rem', fontWeight: 800, lineHeight: 1.2, letterSpacing: '-0.01em' },
  body: { fontSize: '1rem', fontWeight: 400, lineHeight: 1.5 },
  label: { fontSize: '1rem', fontWeight: 600, lineHeight: 1.4 },
  caption: { fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.35 },
  money: { fontSize: '1rem', fontWeight: 800, lineHeight: 1.2, tnum: true },
  'money-lg': { fontSize: '1.5rem', fontWeight: 900, lineHeight: 1.1, tnum: true },
};

export const rounded = { sm: '12px', md: '16px', lg: '24px', pill: '999px' };

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
        raised: '0 -8px 24px rgb(16 20 11 / 0.06)',
      },
    },
  },
  plugins: [
    // A column of amounts only scans when every digit is the same width.
    ({ addUtilities }) => addUtilities(tabular),
    // Rows of a grouped list are parted by a hairline that starts where
    // the text starts and stops short of the card's right edge, as in iOS. It
    // belongs to the lower row, so the first row has none.
    ({ addComponents }) =>
      addComponents({
        '.inset-separated > * + *': { position: 'relative' },
        '.inset-separated > * + *::before': {
          content: '""',
          position: 'absolute',
          top: '0',
          left: spacing.lg,
          right: spacing.lg,
          height: '1px',
          backgroundColor: colors.neutral,
        },
      }),
  ],
};
