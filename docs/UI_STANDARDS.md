# UI Standards — clean, tidy, systematic

> **Owner directive (2026-07):** the UI must be *clean and tidy*. No unnecessary
> element should appear — not a line, not a dot, not a pixel. Every visual atom
> must earn its place.
>
> This document is the **single source of truth** for that bar. It sits on top of
> the Concord design system (`packages/ui/src/tokens.css` defines the type scale,
> colors, spacing, radii). Concord tells you *what* tokens exist; this tells you
> *what to render and — more importantly — what NOT to render*.

Each rule has a stable ID (`UI-1` … `UI-16`). Reference it in code comments and
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

### Page layout (2026-11-05)

The owner's feedback: "every page looks like a different style". Pages had
drifted on titles, surfaces, section headings, buttons, filters, loading and
money type. These rules give every page the same frame. They keep the current
look (colors, nav, flows); they only stop each page from inventing its own.

#### UI-11 — Labels are sentence case
Section headings are `SectionLabel` (13 px semibold, muted, sentence case);
form labels are `FieldLabel`. Nothing is styled `uppercase`: it means nothing in
Chinese, reads badly in Russian/Uzbek, and every copy drifted in size.
A field with one input is a `Field`: its title labels that input. A titled set
of controls (checkboxes, a segmented choice, a switch with its own label) is a
`FieldGroup`. A label around several controls hands a tap on its title to the
first of them (2026-11-09, review UI-01: tapping "Assigned stores" assigned the
member to the first store).
**Enforcement:** CI "Typography guard" fails on any `uppercase` class.

#### UI-12 — One page frame
- A bottom-nav tab page has **no visible title**: the nav names it. The Shell
  renders a hidden `<h1>`. No explanatory paragraph under the top bar.
- A drill-in screen (admin sections) has the back link and a 19 px semibold
  `<h1>` — the `AdminSection` header is the pattern.
- Content sits on the 16 px gutter (`px-4`), blocks are `gap-3` apart.

#### UI-13 — One surface
A group of content is a `Card` (white, `--r-card`, hairline ring). Grey
`--c-surface-2` is for inputs (Input, Select, Textarea) and inline notes, not
for cards. Chips and segmented controls are not grey: a chip is clear with a
hairline, a segment white inside a hairline (`ChipBar`, `Segmented`). No card
inside a card.

#### UI-14 — Money is the body font with tabular figures
Amounts use `tabular-nums` in the normal font so columns line up. Monospace is
only for codes and identifiers (permission keys, build id, JSON).

#### UI-15 — Loading, empty, error look the same everywhere
Loading is the `Spinner` (what `DataState` shows), never a bare "Loading" line;
empty is `EmptyState` (15 px title); errors are `DataState`'s error or a danger
`Banner` with retry.

#### UI-16 — Controls come from the kit
Buttons are `Button` (`sm` h-8 inside rows, `md` h-11 on the page; the page's
main action is the in-page main button, `usePageMainButton` — the Telegram
main button stays hidden since M3.49). Switching between views is
`Segmented`; filtering a list by category is `ChipBar`. No hand-rolled pill
buttons or toggle tracks.
A control that cannot be used looks the same everywhere: half opacity and a
not-allowed cursor, from the kit's `disabledClass` (on the element) or
`disabledLook` (on a label around it). A field someone may not edit must not
look editable (2026-11-10, review UI-11).

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
| `no-hardcoded-oklch` | UI-8 | to add after CC3 token migration |

Rules UI-4/5/6/7/10 are design-review rules (not mechanically checkable); they are
enforced at PR review and by this document.

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
- [ ] Same frame as the other pages: sentence-case labels, no tab title, Card surfaces, tabular money, kit states and controls (UI-11 … UI-16)

---

*A full per-file inventory of current violations (106 findings across 9 areas,
grouped into burn-down batches B1–B10) backs this document; it is tracked
separately as the declutter work order.*
