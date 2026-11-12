# Concord Design System

> Tokens-first, theme-switchable, a11y-by-default. Built on Tailwind v3 + Radix UI.
> What to render and what not to: [UI_STANDARDS.md](UI_STANDARDS.md).
> Three themes: **Native** (the default; light or dark as Telegram or the phone says), **Dark** and **Apple** (high-contrast polished, light only).

## Tokens

All token names are CSS variables defined in `packages/ui/src/tokens.css`. Switching
theme is a single `data-theme=...` attribute change on `<html>`. Tokens use OKLCH
so HDR + sRGB renders match perceived hue.

### Color tokens

| Variable | Role |
|---|---|
| `--c-bg` | App background |
| `--c-surface` | Card / sheet base |
| `--c-surface-2` | Quiet surface (input, chip) |
| `--c-surface-elevated` | Modal, popover |
| `--c-fg` | Primary text |
| `--c-fg-muted` | Secondary text |
| `--c-fg-subtle` | Tertiary text / placeholders |
| `--c-fg-inverse` | Text on `--c-action`/`--c-fg` |
| `--c-action` | Primary CTA |
| `--c-action-hover` | Press / hover state |
| `--c-success`/`warn`/`danger`/`info` | Status |
| `--c-divider` | 1px hairline lines |
| `--c-ring` | Focus outline |

### Radii

| Variable | Use |
|---|---|
| `--r-utility` (8px) | Small internal chrome (buttons in toolbars) |
| `--r-capsule` (11/12px) | Pearl pill, small cards |
| `--r-card` (16/18px) | Cards, sheets |
| `--r-pill` (9999px) | Buttons, inputs |

**Rule:** Never invent intermediate radii. Pick one.

### Typography

System font stack via `--font-sans`. One scale, the `text-old-*`
utilities (packages/ui/tailwind.preset.js; the `old-` prefix is historical):
display 24 · h1 19 · h2 15 · h3 14 · body 13 · body-sm 12 · label 11 ·
tiny 9 px. Which size is for what is written above `--text-display` in
`packages/ui/src/tokens.css`. No arbitrary `text-[15px]`, and nothing
uppercase (UI-11): a section heading is `SectionLabel`.

## Components

Re-exported from `@compass/ui` (the full list is `packages/ui/src/index.ts`).
Each is theme-agnostic via tokens.

| Component | Notes |
|---|---|
| `Button` | 6 variants: primary / secondary / ghost / utility / danger / pearl. `loading` shows Spinner. |
| `Card` / `CardHeader` / `CardTitle` / `CardMeta` | Polymorphic. `interactive` adds press affordance. |
| `Input` | Pill-shaped (`--r-pill`). `invalid` highlights with `--c-danger`. |
| `Sheet` | Bottom sheet via Radix Dialog. Three slots: header / body / footer. Closes by backdrop tap, Esc, the Telegram BackButton, or a pull down on its handle or title. |
| `Banner` | 4 tones: info / success / warn / danger. Optional `action` slot. |
| `Spinner` | Pure SVG, animates via Tailwind `animate-spin`. |
| `EmptyState` | Centered title + optional description + action; `compact` for a line inside a list. |
| `DataState<T>` | Five-state wrapper for `useQuery` data. **Wrap every page in this.** |
| `Skeleton` | `animate-pulse` placeholder. |
| `Chip` / `ChipBar` | Sub-nav category chips. |
| `Avatar` | Initials when `src` is missing or fails to load. Decorative unless given a `label` (the name is beside it). |
| `QtyControl` | 36 px (`sm` 28 px) circular − / + keys that tap as 44 px, long-press accelerator (350ms hold → 90ms tick). |
| `Badge` | Status pill: the localized words as children, and a `tone` (UI-2). |

## A11y rules

- All actionable surfaces use real `<button>`/`<a>` elements (or Radix primitives).
- `aria-label` for icon-only buttons.
- Focus rings via `focus-visible:ring-2 ring-[var(--c-ring)]`.
- `prefers-reduced-motion` honored in tokens (`--t-snap` etc. become 0ms).
- Color is never the only signal — every status pill carries text.

## Press affordance

Add `.press` to any tappable surface. Active state scales to 0.96 over `--t-snap`
(100ms) for the system-wide tap feedback. Reduced-motion users get an instant
state change with no scale.

## Theming hook

```tsx
import { useTheme } from '@compass/ui';
const { theme, setTheme, colorScheme } = useTheme();
```

`colorScheme` reflects Telegram's reported theme when available; otherwise falls back
to `prefers-color-scheme`. Use it to drive `<html data-color-scheme="...">` if you
want auto dark mode.

## What we don't do

- Custom font files (large + privacy-questionable). System stack only.
- shadow on UI elements. Shadows are reserved for product imagery
  (`--shadow-product`).
- Hardcoded hex colors in components. If you reach for `#ff0000`, you missed a token.
- Inline style attributes for layout. CSS variables and utility classes only.
