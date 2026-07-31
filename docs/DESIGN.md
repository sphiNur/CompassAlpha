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
| `--c-capsule` | Translucent capsule fill (secondary/unselected pill controls; no ring) |
| `--c-divider` | 1px hairline lines |
| `--c-ring` | Focus outline |

### Radii

| Variable | Use |
|---|---|
| `--r-utility` (8px) | Tiny squares (checkbox box, code blocks) |
| `--r-card` (16px) | Cards, callouts, textarea |
| `--r-sheet` (24px) | Sheet top edge |
| `--r-pill` (9999px) | Every interactive capsule control: buttons, chips, tabs, inputs |

**Rule:** Never invent intermediate radii. Pick one. (`--r-capsule` 11/12px was
retired in the 2026-07-31 Telegram-capsule pass.)

### Size ladder (2026-07-31, Telegram-capsule pass)

Anchor unit **U = 32px** — the height of Telegram's own top-bar chrome capsule
(Close / ∨⋯). Every element height is a fixed fraction of U on the 4px grid:
micro 20 (5/8U) · dense 28 (7/8U) · capsule 32 (1U) · field 40 (5/4U) ·
CTA 48 (3/2U) · header 56 (7/4U) · nav 64 (2U). Capsule-family text follows
height: 20/28 → 11px, 32 → 12px medium, 40/48 → 14px. See the SIZE LADDER
block in `packages/ui/src/tokens.css` for the token names.

### Typography

System font stack via `--font-sans` (SF Pro inside iOS Telegram — the same face
as the chrome capsule this UI keys off). The scale lives in
`apps/web/tailwind.config.js` + `tokens.css` (M3.14 values): display 24 · h1 19 ·
h2 15 · h3 14 · body 13 · body-sm 12 · label 11 · tiny 9. Use the semantic
`text-*` utilities, never raw pixel classes.

## Components

Re-exported from `@compass/ui`. Each is one-theme-agnostic via tokens.

| Component | Notes |
|---|---|
| `Button` | Variants: primary / secondary / ghost / utility / danger / danger-ghost. `pearl` is a legacy alias of `secondary` (identical since the capsule pass) — prefer `secondary` in new code. Sizes sm 32 / md 40 / lg 48 per the ladder. `loading` shows Spinner. |
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
