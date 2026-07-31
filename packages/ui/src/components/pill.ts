import { cn } from '../cn';

/**
 * The one visual definition of a pill-shaped toggle button, shared by
 * `Chip` and `Tab` (they were two byte-identical copies of this pill —
 * kept in sync by hand). Each component keeps its own semantics (Chip =
 * filter, Tab = roving-tabindex tablist) and appends its extras; the
 * *look* lives here so a tweak lands once.
 *
 * 2026-07-31 (Telegram-capsule pass): this IS the reference capsule —
 * `--capsule-h` (32px, Telegram's chrome-capsule height), fully
 * rounded, `text-body-sm font-medium` (12px — the capsule type rule),
 * and the unselected state is a borderless translucent fill
 * (`--c-capsule`) exactly like Telegram's own Close / ∨⋯ buttons.
 * The old look (transparent + ring-hairline + 11px muted text) read
 * as an outlined ghost next to the real chrome one strip above.
 *
 * See FRONTEND_AUDIT_2026-07.md (T6 primitive-internal drift).
 */
export function pillButtonClass(selected?: boolean): string {
  return cn(
    'press inline-flex h-[var(--capsule-h)] shrink-0 items-center whitespace-nowrap rounded-[var(--r-pill)] px-3 text-body-sm font-medium',
    selected
      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
      : 'bg-[var(--c-capsule)] text-[var(--c-fg)]',
  );
}
