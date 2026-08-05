# UI Standards — clean, tidy, systematic

> **Owner directive (2026-07):** the UI must be *clean and tidy*. No unnecessary
> element should appear — not a line, not a dot, not a pixel. Every visual atom
> must earn its place.
>
> This document is the **single source of truth** for that bar. It sits on top of
> the Concord design system (`packages/ui/src/tokens.css` defines the type scale,
> colors, spacing, radii). Concord tells you *what* tokens exist; this tells you
> *what to render and — more importantly — what NOT to render*.

Each rule has a stable ID (`UI-1` … `UI-10`). Reference it in code comments and
CI guards. When a rule genuinely must be broken, add a one-line
`// UI-N exception: <reason>` comment above the line — the CI guards honor that
exact marker (same pattern as the existing `M3.13 typography exception`).

---

## Core principle

**Hierarchy comes from weight and color, never from adding elements.** Concord
gives three ink levels — `--c-fg` (primary), `--c-fg-muted` (secondary),
`--c-fg-subtle` (tertiary). Use them. Do not reach for a chip, a border, a badge,
an icon, or a bigger font when a color/weight change says the same thing.

The default answer to "should this element be here?" is **no**. Clutter is the
common failure, not sparseness. When in doubt, remove it and see if anyone misses
it.

---

## The rules

### UI-1 — No decorative emoji in rendered UI
An emoji may appear in the rendered app **only if it is the sole carrier of a
distinction** the user needs at that spot. A glyph sitting next to text that
already says the same thing is noise.
- **Don't:** `📝 其他物品`, `🧾 采购支出`, `🌐 语言`, `🛒 {supplierName}`, a `🪑`/`🏪`
  before a store name, a `🥕` in a header.
- **Do:** drop the glyph when adjacent text conveys the meaning. When a glyph
  encodes *state* (cash vs transfer, assigned vs unassigned supplier, store vs
  org), replace it with a localized word or a color — never delete the signal.
- **Exempt:** copy-paste message templates sent to Telegram (`useI18n.ts`
  vendor/copy strings) — those are chat messages, not UI chrome. Code comments.
- **Enforcement:** `ci: no-emoji-in-ui` (grep over `apps/web/src/**/*.tsx`
  rendered text; allow-list documented in the guard).

### UI-2 — Status is localized once, via the shared helper
A status is shown in the user's language, from one place, and **at most once per
view**.
- Never render a raw status enum (`{row.status}`, `<Badge status={x}/>` with no
  children) — it leaks English (`rejected`, `finished`).
- Never state the same status two or three times on one surface. If a tab, a
  section header, or a callout already states it, the per-row badge is redundant —
  delete it.
- If a status can only ever be one value at a spot (a `finished`-only history
  list, a status-filtered tab), it carries no information — **delete it**, don't
  localize it.
- **Do:** derive the label from `statusLabel(status)` (localized map) and pass it
  as `children`; Concord's `Badge` is intentionally i18n-agnostic, so localization
  happens at the call site.

### UI-3 — Hide zero and default values
Do not render a count, unit, or field that is zero, empty, or the default.
- **Don't:** `其他 0 项`, `(0)`, a `× 千` badge when thousands-mode is off, an
  empty per-store chip, a `— {reason}` when there is no reason.
- **Do:** guard the element (`{n > 0 && …}`) and collapse the surrounding
  separators with it (no dangling ` · `).

### UI-4 — Bilingual names: two lines, never truncated inline
A product/entity with a primary and secondary language renders the primary name
on its own line and the secondary as a muted second line — never
`primary (secondary)` inline, which doubles the width and truncates mid-word
(`To'g'ralgan s…`).
- **Do:** `useProductNameParts()` → `{ primary, secondary }`; render `secondary`
  in `text-[var(--c-fg-subtle)]`, or omit it on very narrow rows.
- **Don't:** `useProductName()` returning `` `${primary} (${secondary})` `` in a
  row title.

### UI-5 — One accent per view; secondary actions stay quiet
At most one element per screen carries the action color. Everything else expresses
priority through weight and color, not equal-weight buttons.
- **Don't:** a row where `退回审核`, `修改采购记录`, `撤销` are all bordered pills of
  equal prominence.
- **Do:** keep the one state-changing primary bordered/accented; demote the rest to
  muted text or an overflow/tap target.

### UI-6 — Dense lists are bordered rows, not stacked cards
A list of like items is one container with hairline-separated rows — not N
individual `rounded-card ring-hairline` cards, which stack N borders and N gaps.
- **Do:** one outer `r-card ring-hairline`; rows are `border-b
  border-[var(--c-divider)] last:border-b-0`.
- Applies to member lists, submission lists, SKU lists, pickers.

### UI-7 — No redundant or decorative dividers
A rule/border must separate two *meaningful* groups. Delete any line that doesn't.
- **Don't:** a card border **and** an inner divider **and** a sticky-strip
  `border-b` all meeting at one seam; a `border-b` over an empty state; segmented-
  control internal dividers when the active fill already delineates.
- One separator per boundary, maximum.

### UI-8 — Tokens only; no hardcoded colors/spacing
Every color, radius, gap, and font-size comes from a Concord token. No literal
`oklch(...)`/hex in components (they break dark mode), no magic px where a
`--gap-*`/`--r-*` token exists.
- **Don't:** `bg-[oklch(95%_0.06_145)]` — use `bg-[var(--c-success-bg)]` (it has a
  dark-theme override).

### UI-9 — Sentence case, localized, no mixed language
All user-visible copy is localized (4 catalogs: zh/en/ru/uz, key parity enforced)
and sentence case. No English literal in a Chinese-default screen — not in labels,
placeholders, empty states, `aria-label`s, or toast/banner arguments.

### UI-10 — Every element earns its place
Before adding anything — a chip, a line, an icon, a helper paragraph, a status
slot, a date — ask what it tells the user that nothing else on screen already
does. If the answer is "nothing," don't add it. This rule outranks any instinct to
"show more."

### UI-11 — Every size is a fixed fraction of the capsule unit
**Added 2026-07-31 (Telegram-capsule pass).** The app runs inside Telegram, and
the user's eye calibrates against the chrome Telegram draws one strip above our
content: the `Close` / `∨ ⋯` capsule buttons, **32px** tall. That is the anchor
unit **U**. Every element height in the app is a fixed fraction of U, on the 4px
grid — never a value picked to look right in isolation:

| Tier | px | ×U | Token | Who |
|---|---|---|---|---|
| micro | 20 | 5/8 | `h-5` | Badge, Switch track |
| dense | 28 | 7/8 | `--control-h-xs` | QtyControl sm, Segmented sm, NumberInput sm, Stepper |
| **capsule** | **32** | **1** | `--capsule-h` = `--control-h-sm` | Chip, Tab, Button sm, SearchInput, Segmented md, NumberInput md, QtyControl md |
| field | 40 | 5/4 | `--control-h` | Input, Select, Button md |
| touch | 44 | 11/8 | `--control-h-touch` | **restricted** — see below |
| CTA | 48 | 3/2 | `--control-h-lg` | Button lg, PageMainButton |
| header | 56 | 7/4 | `--app-header-h` | web-fallback header |
| nav | 64 | 2 | `--app-nav-h` | bottom nav |

The **touch** tier is iOS HIG's 44px floor and is not a free choice. It applies
only to a control that *commits state* inside a *vertically scrolling dense
list*, where the thumb travels past its neighbours — today, RunViews' per-row
✓-save and payment-method buttons. Reaching for the 48 CTA tier there would eat
the dead space that stops an off-by-one-row tap from committing money against the
wrong SKU (52px row − 44px control = 8px between commit targets; at 48 it drops
to 4). Everywhere else: field or CTA.

Type follows height, so a control never carries a label out of proportion to its
box: **20/28 → `text-label` (11) · 32 → `text-body-sm font-medium` (12) ·
40/48 → `text-h3` (14)**. Horizontal padding follows too: 32 → `px-3`,
40 → `px-4`/`px-5`, 48 → `px-6`.

- **Don't:** `h-9`, `h-11`, `h-[52px]`, `py-2` standing in for a height, or a new
  intermediate tier because one screen felt cramped.
- **Do:** pick the tier that matches the control's role and use its token.

**Spacing** is on the same 4px grid. Tailwind's `0.5` (2px) and `1.5` (6px) steps
stay available as *inline* nudges between adjacent inline elements; block padding
uses whole steps. The `2.5` step (10px) is banned outright — it is the
"split the difference" value people reach for when a block feels a pixel off, and
it is precisely how the app accumulated `py-2` / `py-2.5` / `py-3` variants of one
row. **List rows are content-sized, not ladder-sized** — a fixed height would clip
wrapped Uzbek and Russian labels. Their *padding* is what must be consistent.

### UI-12 — Capsule controls are filled, not outlined
**Added 2026-07-31.** Telegram's chrome capsules have no border: a translucent
neutral fill states the shape. Ours match.

- Unselected / secondary capsule control → `bg-[var(--c-capsule)]`, **no**
  `ring-hairline`, **no** `border`.
- Selected / primary → `bg-[var(--c-action)] text-[var(--c-action-fg)]`.
- Form fields (Input, Select, SearchInput, NumberInput, Textarea) →
  `bg-[var(--c-surface-2)]`, no *resting* ring. Focus rings and
  invalid/danger rings stay — they signal state, not shape.
- Shape tokens: interactive → `--r-pill`; container/card/callout → `--r-card`;
  sheet top edge → `--r-sheet`; tiny square (checkbox) → `--r-utility`. There is
  no intermediate radius (`--r-capsule` was retired in this pass).

Cards keep their `ring-hairline` — a card is a surface, not a capsule. This rule
is about controls.

---

## Enforcement (CI)

Rules that are grep-checkable are enforced in `.github/workflows/ci.yml` (unit
job), alongside the existing typography-drift and no-`console.log` guards. A guard
fails the build and prints the offending lines; a documented `// UI-N exception:`
marker above a line whitelists it.

| Guard | Enforces | Status |
|-------|----------|--------|
| `no-emoji-in-ui` | UI-1 | to add once burn-down completes; allow-list = remaining state-encoding sites |
| `no-raw-status-enum` | UI-2 | to add with the `statusLabel` helper |
| `no-hardcoded-oklch` | UI-8 | **live** (2026-07-31) — bans `[oklch(…)]` / hex color utilities in `apps/web/src` + `packages/ui/src` |
| `capsule-size-ladder` | UI-11 | **live** (2026-07-31) — bans off-ladder `h-7/h-9/h-11/h-13` and raw Tailwind text-scale classes |

Rules UI-4/5/6/7/10/12 are design-review rules (not mechanically checkable — a
hairline on a *card* is correct and on a *control* is not, which grep can't
tell apart); they are enforced at PR review and by this document.

---

## New-screen checklist

Before a screen ships, walk the rules top to bottom:

- [ ] No decorative emoji (UI-1)
- [ ] Every status localized, stated once, deleted if constant (UI-2)
- [ ] No zero/default values rendered (UI-3)
- [ ] Bilingual names two-line, no inline-paren truncation (UI-4)
- [ ] Exactly one accent; secondary actions quiet (UI-5)
- [ ] Dense lists are bordered rows, not cards (UI-6)
- [ ] One separator per boundary, none over empty states (UI-7)
- [ ] Tokens only, no hardcoded colors/spacing (UI-8)
- [ ] All copy localized, sentence case, no mixed language (UI-9)
- [ ] Every remaining element earns its place (UI-10)
- [ ] Every height is a ladder tier; type + padding follow it (UI-11)
- [ ] Controls are filled capsules, not outlined; cards keep their hairline (UI-12)

---

*A full per-file inventory of current violations (106 findings across 9 areas,
grouped into burn-down batches B1–B10) backs this document; it is tracked
separately as the declutter work order.*
