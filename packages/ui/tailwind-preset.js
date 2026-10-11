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
/** Light values. Each is also a CSS variable, so a screen never names a hex. */
export const colors = {
  primary: '#A3E635',
  'primary-pressed': '#8FD11F',
  'primary-pale': '#E4F7CC',
  'on-primary': '#10140B',
  forest: '#1F3A12',
  ink: '#10140B',
  secondary: '#5A5E55',
  neutral: '#FFFFFF',
  surface: '#F1F3EE',
  'surface-sunken': '#E1E5DB',
  field: '#FFFFFF',
  line: '#C4C9BC',
  contrast: '#10140B',
  'on-contrast': '#A3E635',
  hero: '#10140B',
  'on-hero': '#A3E635',
  'hero-text': '#DDE3D2',
  warning: '#FFD11A',
  'warning-pale': '#FFF1B8',
  'warning-ink': '#4A3B1C',
  danger: '#C8322F',
  'danger-pale': '#FBE1DF',
  'danger-ink': '#8E1F1C',
  'on-danger': '#FFFFFF',
};

/** The same names in the dark. A token missing here would stay light on a dark page. */
export const colorsDark = {
  primary: '#A3E635',
  'primary-pressed': '#8FD11F',
  'primary-pale': '#2B3A1A',
  'on-primary': '#10140B',
  forest: '#BFEA8A',
  ink: '#F1F4EC',
  secondary: '#B4B8AD',
  neutral: '#121511',
  surface: '#232621',
  'surface-sunken': '#33372F',
  field: '#121511',
  line: '#4A4F45',
  contrast: '#F1F4EC',
  'on-contrast': '#10140B',
  hero: '#2B3A1A',
  'on-hero': '#A3E635',
  'hero-text': '#DDE3D2',
  warning: '#FFD11A',
  'warning-pale': '#3F3414',
  'warning-ink': '#F3DFA2',
  danger: '#E5534F',
  'danger-pale': '#3A1B1A',
  'danger-ink': '#F3A6A2',
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
  h1: { fontSize: '1.75rem', fontWeight: 700, lineHeight: 1.15, letterSpacing: '-0.02em' },
  h2: { fontSize: '1.375rem', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.01em' },
  body: { fontSize: '1rem', fontWeight: 400, lineHeight: 1.5 },
  label: { fontSize: '1rem', fontWeight: 600, lineHeight: 1.4 },
  small: { fontSize: '0.875rem', fontWeight: 400, lineHeight: 1.45 },
  caption: { fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.35 },
  money: { fontSize: '1rem', fontWeight: 700, lineHeight: 1.2, tnum: true },
  'money-lg': { fontSize: '1.5rem', fontWeight: 800, lineHeight: 1.1, tnum: true },
};

export const rounded = { sm: '12px', md: '16px', lg: '24px', pill: '999px' };

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  page: '16px',
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

/** "#A3E635" -> "163 230 53", the form Tailwind's opacity modifier needs. */
function channels(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function cssVars(palette) {
  return Object.fromEntries(
    Object.entries(palette).map(([name, hex]) => [`--fine-${name}`, channels(hex)]),
  );
}

const themeColors = Object.fromEntries(
  Object.keys(colors).map((name) => [name, `rgb(var(--fine-${name}) / <alpha-value>)`]),
);

/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: themeColors,
      fontSize,
      borderRadius: rounded,
      spacing: { ...spacing, ...sizes },
      boxShadow: {
        // The one shadow the design allows: under a sheet or a pinned
        // action bar, to separate it from content scrolling beneath.
        raised: '0 -8px 24px rgb(0 0 0 / 0.08)',
      },
    },
  },
  plugins: [
    // A column of amounts only scans when every digit is the same width.
    ({ addUtilities }) => addUtilities(tabular),
    // Every colour is a variable with a light and a dark value. The dark
    // set applies when the system (or Telegram) is dark, unless the page
    // says data-theme="light"; data-theme="dark" forces it either way.
    ({ addBase }) =>
      addBase({
        ':root': { ...cssVars(colors), colorScheme: 'light' },
        '@media (prefers-color-scheme: dark)': {
          ':root:not([data-theme="light"])': { ...cssVars(colorsDark), colorScheme: 'dark' },
        },
        ':root[data-theme="dark"]': { ...cssVars(colorsDark), colorScheme: 'dark' },
      }),
  ],
};
