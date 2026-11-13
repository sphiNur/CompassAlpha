/**
 * Which tabs sit in the bottom bar and which behind "More" (owner,
 * 2026-11-14: a floating capsule with at most five items, four + More
 * when a member sees more than five tabs).
 *
 * Pure, so the pager that swipes between bar tabs (step 2) reads the same
 * ordered list the bar draws.
 */
import type { Tab } from '../../stores/navStore';

/** The most items the bar shows, More included. */
export const MAX_BAR_ITEMS = 5;

/**
 * Someone who works across the stores (runs the market trips or
 * administers the organisation) keeps review, buying, the daily close and
 * admin at hand; ordering and receiving are a store's own work.
 */
const ORG_PRIORITY: readonly Tab[] = [
  'approve',
  'run',
  'settlement',
  'admin',
  'order',
  'confirm',
  'history',
  'attendance',
  'sales',
];

/** Someone who works in a store keeps that store's daily work at hand. */
const STORE_PRIORITY: readonly Tab[] = [
  'order',
  'approve',
  'settlement',
  'confirm',
  'sales',
  'attendance',
  'history',
  'run',
  'admin',
];

/** Permissions that mean the member works across the stores, not in one. */
const ORG_WIDE_PERMISSIONS = ['run.purchase', 'org.admin'];

export interface NavLayout<T> {
  /** The bar's tabs, in the canonical tab order (TAB_KEYS). */
  bar: T[];
  /** The tabs behind More, most used first; empty when everything fits. */
  more: T[];
}

/**
 * Splits the visible tabs (in canonical order) into the bar and More.
 * With five or fewer, all of them are in the bar. With more, four are
 * picked by a priority that follows the member's permissions (`permissions`:
 * the union over their stores), and More is the fifth item.
 */
export function navLayout<T extends { key: Tab }>(
  tabs: readonly T[],
  permissions: readonly string[],
): NavLayout<T> {
  if (tabs.length <= MAX_BAR_ITEMS) return { bar: [...tabs], more: [] };
  const orgWide = ORG_WIDE_PERMISSIONS.some((p) => permissions.includes(p));
  const priority = orgWide ? ORG_PRIORITY : STORE_PRIORITY;
  const rank = (key: Tab) => priority.indexOf(key);
  const byPriority = [...tabs].sort((a, b) => rank(a.key) - rank(b.key));
  const barKeys = new Set(byPriority.slice(0, MAX_BAR_ITEMS - 1).map((t) => t.key));
  return {
    bar: tabs.filter((t) => barKeys.has(t.key)),
    more: byPriority.filter((t) => !barKeys.has(t.key)),
  };
}
