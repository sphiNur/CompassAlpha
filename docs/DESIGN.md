# Concord Design System

> Tokens-first, theme-switchable, a11y-by-default. Built on Tailwind v4 + Radix UI.
> Two themes: **Native** (Telegram-themed) and **Apple** (high-contrast polished).

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

System font stack via `--font-sans`. Hierarchy in Tailwind utilities:

| Class | Size / weight | Use |
|---|---|---|
| `text-[28px] font-semibold tracking-tight` | Hero / H1 | Page title |
| `text-[20px] font-semibold tracking-tight` | H2 | Section title |
| `text-[17px] font-semibold` | Body strong | List row title, button label |
| `text-[15px]` | Body | Default |
| `text-[13px] text-[var(--c-fg-muted)]` | Caption | Subtitle, timestamp |
| `text-[12px] uppercase tracking-wide text-[var(--c-fg-muted)]` | Eyebrow | Label above metric |

## Components

Re-exported from `@compass/ui`. Each is one-theme-agnostic via tokens.

| Component | Notes |
|---|---|
| `Button` | 6 variants: primary / secondary / ghost / utility / danger / pearl. `loading` shows Spinner. |
| `Card` / `CardHeader` / `CardTitle` / `CardMeta` | Polymorphic. `interactive` adds press affordance. |
| `Input` | Pill-shaped (`--r-pill`). `invalid` highlights with `--c-danger`. |
| `Sheet` | Bottom sheet via Radix Dialog. Three slots: header / body / footer. |
| `Banner` | 4 tones: info / success / warn / danger. Optional `action` slot. |
| `Spinner` | Pure SVG, animates via Tailwind `animate-spin`. |
| `EmptyState` | Centered icon + title + optional description + action. |
| `DataState<T>` | Five-state wrapper for `useQuery` data. **Wrap every page in this.** |
| `Skeleton` | `animate-pulse` placeholder. |
| `Stepper` | Numbered step indicator with done/active/pending styles. |
| `Chip` / `ChipBar` | Sub-nav category chips. |
| `Avatar` | Initials fallback when `src` missing. |
| `QtyControl` | 44×44 circular chips, long-press accelerator (350ms hold → 90ms tick). |
| `Badge` | Status pill. Pass `status` for auto-tone or `tone` directly. |

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
