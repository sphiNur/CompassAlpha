/**
 * S2 (2026-11-13): a reviewer opens the app where the work is. When an
 * order waits for review in the store in the top bar, a cold start lands
 * on 审核 instead of the tab the app would restore (Order for a manager).
 *
 * Only on a cold start, never over a link (a notification or a bot button
 * names its own tab) and never once the person has tapped or typed. The
 * counts come from the restored copy when it is recent, so the first
 * screen is already Review; otherwise the app waits a moment for the
 * fresh ones and stays put if they come late.
 */
import type { Tab } from '../../stores/navStore';

/** How long after start a fresh count may still move the person. */
export const LANDING_WINDOW_MS = 2_000;
/** A restored count older than this is not trusted to decide. */
export const LANDING_COUNTS_MAX_AGE_MS = 10 * 60 * 1000;

export interface LandingInput {
  /** The tabs the person sees in the store in the top bar. */
  visibleKeys: readonly Tab[];
  /** The tab the app opened on. */
  currentTab: Tab;
  /** The top bar names one store (not all stores, not none). */
  oneStore: boolean;
  /** Opened from a link that names a tab (path or start param). */
  deepLinked: boolean;
  /** The person tapped or typed since the app started. */
  userActed: boolean;
  /** Since the app started. */
  elapsedMs: number;
  /** The nav counts' review count and their age; null while none is loaded. */
  counts: { approve: number | null; ageMs: number } | null;
}

/** `wait`: no usable count yet; `stay`: leave the tab; `review`: open Review. */
export type LandingVerdict = 'wait' | 'stay' | 'review';

export function landingVerdict(input: LandingInput): LandingVerdict {
  if (input.deepLinked || input.userActed || !input.oneStore) return 'stay';
  if (!input.visibleKeys.includes('approve') || input.currentTab === 'approve') return 'stay';
  if (input.elapsedMs > LANDING_WINDOW_MS) return 'stay';
  const counts =
    input.counts && input.counts.ageMs <= LANDING_COUNTS_MAX_AGE_MS ? input.counts : null;
  if (!counts) return 'wait';
  return (counts.approve ?? 0) > 0 ? 'review' : 'stay';
}
