/**
 * Name filter for the preview card's grouped lists.
 *
 * Exists because of the accordion. Collapsing every group by default is
 * what the operator asked for, but it removed the one thing the old
 * always-expanded list was good at: scrolling to find a SKU. In the
 * market that is not a nicety — "this stall is out of tomatoes, I bought
 * them three stalls later" means finding a row that lives in a group you
 * are not standing in front of, and with everything shut there was no
 * way to do that but open nine groups one at a time.
 *
 * Matching delegates to lib/searchMatch, so a Russian speaker typing
 * "молоко" still finds a SKU whose display name resolved to Chinese, and
 * "tomto" still finds tomatoes. The stall name is part of the haystack
 * too: typing a stall filters the by-STORE view down to that stall's
 * items, which is exactly the "what am I buying here" question.
 */
import { matchesAnyString } from '../../../lib/searchMatch';
import type { PreviewLine, PreviewStoreGroup, PreviewSupplierGroup } from '../types';

/** Extra searchable strings for a line beyond its own display name. */
export type LineHaystack = (line: PreviewLine) => Array<string | null | undefined>;

function lineMatches(line: PreviewLine, tokens: string[], extra?: LineHaystack): boolean {
  return matchesAnyString([line.name, line.supplierName, ...(extra?.(line) ?? [])], tokens);
}

/**
 * Keep only matching lines; drop groups left with nothing.
 *
 * `legacyNote` is deliberately NOT carried through a filtered group: it
 * is a free-text note about the whole store, and repeating it next to
 * three filtered rows implies it applies to them.
 */
export function filterStoreGroups(
  groups: readonly PreviewStoreGroup[],
  tokens: string[],
  extra?: LineHaystack,
): PreviewStoreGroup[] {
  if (tokens.length === 0) return [...groups];
  const out: PreviewStoreGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter((l) => lineMatches(l, tokens, extra));
    if (items.length > 0) out.push({ ...g, items, legacyNote: undefined });
  }
  return out;
}

/** Same, one level deeper: supplier → store → items. */
export function filterSupplierGroups(
  groups: readonly PreviewSupplierGroup[],
  tokens: string[],
  extra?: LineHaystack,
): PreviewSupplierGroup[] {
  if (tokens.length === 0) return [...groups];
  const out: PreviewSupplierGroup[] = [];
  for (const g of groups) {
    const stores = filterStoreGroups(g.stores, tokens, extra);
    if (stores.length > 0) out.push({ ...g, stores });
  }
  return out;
}

/**
 * Total line count across store groups.
 *
 * Rows, not distinct items: this labels a filtered LIST ("3 of 27
 * shown"), so it has to count the same things the list renders. The
 * header's run-wide figures count distinct items instead and are
 * deliberately left untouched by filtering — they are facts about the
 * run, not about the current query.
 */
export function countStoreLines(groups: readonly PreviewStoreGroup[]): number {
  let n = 0;
  for (const g of groups) n += g.items.length;
  return n;
}

export function countSupplierLines(groups: readonly PreviewSupplierGroup[]): number {
  let n = 0;
  for (const g of groups) n += countStoreLines(g.stores);
  return n;
}
