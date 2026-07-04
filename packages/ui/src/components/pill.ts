import { cn } from '../cn';

/**
 * The one visual definition of a pill-shaped toggle button, shared by
 * `Chip` and `Tab` (they were two byte-identical copies of this pill —
 * `h-8 rounded-pill px-3 text-label font-medium` with the same
 * selected/unselected branch — kept in sync by hand). Each component
 * keeps its own semantics (Chip = filter, Tab = roving-tabindex tablist)
 * and appends its extras; the *look* lives here so a tweak lands once.
 *
 * See FRONTEND_AUDIT_2026-07.md (T6 primitive-internal drift).
 */
export function pillButtonClass(selected?: boolean): string {
  return cn(
    'press inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[var(--r-pill)] px-3 text-label font-medium',
    selected
      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
      : 'bg-transparent text-[var(--c-fg-muted)] ring-hairline',
  );
}
