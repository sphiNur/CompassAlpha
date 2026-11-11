import uiPreset from '@compass/ui/tailwind.preset';

/** @type {import('tailwindcss').Config} */
export default {
  // Review UI-16 (2026-11): the preset of the rejected redesign is gone.
  // Its `text-h2` / `rounded-md` / colours took Tailwind's names with other
  // values; no screen used them (the built CSS is the same without it).
  // Review UI-15 (2026-11-10): the type scale (`text-old-*`) comes from
  // the component library, which is what needs it.
  presets: [uiPreset],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  plugins: [],
};
