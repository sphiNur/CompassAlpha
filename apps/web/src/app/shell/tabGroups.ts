/**
 * Owner 2026-11-23: tabs that are one piece of work share one place in the
 * bar. The more a role may do, the more tabs it had, and the bar holds
 * five: a manager's or an admin's History and Receiving ended up behind
 * More although they belong to two flows already in the bar.
 *
 *   - Orders (订货): ordering and receiving. Receiving is the step after
 *     an order, in the same store.
 *   - Buying (采购): the current run and the history of past runs.
 *
 * A group is a nav idea only. Each member keeps its own Tab key, page,
 * deep link (`tab_confirm`), saved tab and title; the bar shows the group
 * once, at the place of its first member the person can see, and the page
 * shows a switch between the members (GroupSwitch.tsx). With one member
 * visible there is no group: that tab stands alone, under its own name
 * (a store manager without run.purchase has History, not Buying).
 *
 * Pure, so the bar, the More page, the swipe ring and the tests read the
 * same rules.
 */
import type { CatalogKey } from '@compass/i18n';
import type { NavBadge } from '../../lib/navBadges';
import type { Tab } from '../../stores/navStore';

export interface TabGroup {
  /** The members, in the order the switch shows them; the first leads. */
  tabs: readonly Tab[];
  /** The bar's words for the group; the first member's own when absent. */
  labelKey?: CatalogKey;
  shortKey?: CatalogKey;
}

export const TAB_GROUPS: readonly TabGroup[] = [
  { tabs: ['order', 'confirm'], labelKey: 'nav.group.orders', shortKey: 'nav.short.group.orders' },
  { tabs: ['run', 'history'] },
];

interface Labelled {
  key: Tab;
  labelKey: CatalogKey;
  shortKey: CatalogKey;
}

/** A bar or More entry: a tab, or a group under its first visible member's key. */
export type Entry<T extends Labelled> = T & {
  /** The group's visible members (two or more); absent for a lone tab. */
  members?: readonly Tab[];
};

function groupOf(tab: Tab): TabGroup | null {
  return TAB_GROUPS.find((g) => g.tabs.includes(tab)) ?? null;
}

/**
 * The visible tabs as entries: a group with two or more visible members
 * becomes one entry, at its first member's place, keyed by it and named
 * by the group; other tabs pass through.
 */
export function groupEntries<T extends Labelled>(tabs: readonly T[]): Entry<T>[] {
  const keys = new Set(tabs.map((t) => t.key));
  const out: Entry<T>[] = [];
  for (const t of tabs) {
    const group = groupOf(t.key);
    const members = group ? group.tabs.filter((k) => keys.has(k)) : [];
    if (!group || members.length < 2) {
      out.push(t);
      continue;
    }
    if (members[0] !== t.key) continue;
    out.push({
      ...t,
      labelKey: group.labelKey ?? t.labelKey,
      shortKey: group.shortKey ?? t.shortKey,
      members,
    });
  }
  return out;
}

/** The entry that stands for `tab`: its group's, or its own key. */
export function entryKeyFor(
  tab: Tab,
  entries: readonly { key: Tab; members?: readonly Tab[] }[],
): Tab {
  return entries.find((e) => e.members?.includes(tab))?.key ?? tab;
}

/** The members of the group `tab` is open in; empty for a lone tab. */
export function membersAround(
  tab: Tab,
  entries: readonly { key: Tab; members?: readonly Tab[] }[],
): readonly Tab[] {
  return entries.find((e) => e.members?.includes(tab))?.members ?? [];
}

/**
 * Which member a tap on a group opens: the one last open in it, unless
 * another member has something waiting and that one does not (a delivery
 * to receive takes the store to Receiving); the first member otherwise.
 */
export function memberToOpen(
  members: readonly Tab[],
  last: Tab | undefined,
  badges: Partial<Record<Tab, NavBadge>>,
): Tab {
  const remembered = last && members.includes(last) ? last : members[0]!;
  if (badges[remembered] !== undefined) return remembered;
  return members.find((m) => badges[m] !== undefined) ?? remembered;
}

/** A group's badge: the members' counts added, else a dot if any has one. */
export function groupBadge(
  badges: Partial<Record<Tab, NavBadge>>,
  members: readonly Tab[],
): NavBadge | undefined {
  let count = 0;
  let dot = false;
  for (const m of members) {
    const b = badges[m];
    if (b === 'dot') dot = true;
    else if (typeof b === 'number') count += b;
  }
  if (count > 0) return count;
  return dot ? 'dot' : undefined;
}
