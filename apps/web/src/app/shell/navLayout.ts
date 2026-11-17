/**
 * Which tabs sit in the bottom bar and which on the More page.
 *
 * Owner 2026-11-14: a floating capsule. Owner 2026-11-17: Admin moves to
 * the More page (it is never in the bar), ordering and clock-in go in the
 * bar, and only the open tab shows its word, so the bar holds up to five
 * tabs + More. More is a page (MorePage.tsx), not a sheet: the tabs the
 * bar has no room for, Settings in a browser, Admin below them.
 *
 * Pure, so the pager that swipes between bar items reads the same list
 * the bar draws.
 */
import type { Tab } from '../../stores/navStore';

/** The most tabs the bar shows; More comes after them. */
export const MAX_BAR_TABS = 5;

/**
 * Someone who works across the stores (runs the market trips or
 * administers the organisation) keeps review, buying and the daily close
 * at hand, then ordering and clock-in (owner 2026-11-17).
 */
const ORG_PRIORITY: readonly Tab[] = [
  'approve',
  'run',
  'settlement',
  'order',
  'attendance',
  'confirm',
  'history',
  'sales',
];

/**
 * Someone who works in a store keeps that store's daily work at hand:
 * ordering and clock-in first (owner 2026-11-17).
 */
const STORE_PRIORITY: readonly Tab[] = [
  'order',
  'attendance',
  'approve',
  'confirm',
  'settlement',
  'sales',
  'history',
  'run',
];

/** Permissions that mean the member works across the stores, not in one. */
const ORG_WIDE_PERMISSIONS = ['run.purchase', 'org.admin'];

export interface NavLayout<T> {
  /** The bar's tabs, in the canonical tab order (TAB_KEYS); never Admin. */
  bar: T[];
  /** The tabs listed on the More page, most used first (not Admin). */
  more: T[];
  /** Admin, drawn on the More page; null when the member may not open it. */
  admin: T | null;
  /** Whether there is a More page (and a More item in the bar). */
  morePage: boolean;
}

/**
 * Splits the visible tabs (in canonical order) into the bar and the More
 * page. With five or fewer (Admin aside) all of them are in the bar; with
 * more, five are picked by a priority that follows the member's
 * permissions (`permissions`: the union over their stores).
 */
export function navLayout<T extends { key: Tab }>(
  tabs: readonly T[],
  permissions: readonly string[],
  /** A browser: More always exists, as it holds Settings. */
  alwaysMore = false,
): NavLayout<T> {
  const admin = tabs.find((t) => t.key === 'admin') ?? null;
  const pages = tabs.filter((t) => t.key !== 'admin' && t.key !== 'more');
  let bar: T[];
  let more: T[];
  if (pages.length <= MAX_BAR_TABS) {
    bar = pages;
    more = [];
  } else {
    const orgWide = ORG_WIDE_PERMISSIONS.some((p) => permissions.includes(p));
    const priority = orgWide ? ORG_PRIORITY : STORE_PRIORITY;
    const rank = (key: Tab) => {
      const i = priority.indexOf(key);
      return i === -1 ? priority.length : i;
    };
    const byPriority = [...pages].sort((a, b) => rank(a.key) - rank(b.key));
    const barKeys = new Set(byPriority.slice(0, MAX_BAR_TABS).map((t) => t.key));
    bar = pages.filter((t) => barKeys.has(t.key));
    more = byPriority.filter((t) => !barKeys.has(t.key));
  }
  return { bar, more, admin, morePage: more.length > 0 || admin !== null || alwaysMore };
}
