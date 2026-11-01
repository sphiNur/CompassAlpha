/**
 * Bottom-nav badges (DX-SHL-23 / DX-APR-5 / DX-DLV-13, 2026-11-01).
 *
 * `nav.counts` answers per store and per permission; this maps the answer
 * onto the tabs the person can see. A count of 0, or a count the server
 * withheld (null), draws nothing. 日结 is a dot: "not filed today" has no
 * number.
 */
import type { Tab } from '../stores/navStore';

export type NavBadge = number | 'dot';

export interface NavCounts {
  approve: number | null;
  run: number | null;
  confirm: number | null;
  settlementDue: boolean | null;
}

export function navBadges(
  counts: NavCounts | undefined,
  visibleTabs: readonly Tab[],
): Partial<Record<Tab, NavBadge>> {
  const out: Partial<Record<Tab, NavBadge>> = {};
  if (!counts) return out;
  const visible = new Set(visibleTabs);
  const put = (tab: Tab, n: number | null) => {
    if (visible.has(tab) && n !== null && n > 0) out[tab] = n;
  };
  put('approve', counts.approve);
  put('run', counts.run);
  put('confirm', counts.confirm);
  if (visible.has('settlement') && counts.settlementDue === true) out.settlement = 'dot';
  return out;
}
