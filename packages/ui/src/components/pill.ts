import { cn } from '../cn';
import { disabledClass } from './disabled';

/**
 * The one visual definition of a pill-shaped toggle button: `Chip`, and
 * the pages that draw a pill of their own (it was copied byte for byte
 * into Chip and the kit's Tab, kept in sync by hand). The *look* lives
 * here so a tweak lands once.
 *
 * From the 2026-07 frontend audit (T6 primitive-internal drift). Review
 * UI-32 (2026-11-12): Tab is gone; the approval page, its one user,
 * switches with Segmented since ORD-22.
 */
export function pillButtonClass(selected?: boolean): string {
  return cn(
    // V4 (2026-10-30): 32 px tall to look at, 44 px to tap (hit-44). The
    // ChipBar rows pad 6 px above and below, which is exactly
    // what the tap area needs inside their horizontal scroller.
    'press hit-44 inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[var(--r-pill)] px-3 text-old-label font-medium',
    disabledClass,
    selected
      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
      : 'bg-transparent text-[var(--c-fg-muted)] ring-hairline',
  );
}
