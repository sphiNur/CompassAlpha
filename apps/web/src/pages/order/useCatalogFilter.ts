/**
 * The order page's catalog as filtered by the search field and the
 * category chips, grouped for the list (review ORD-10, step 2: moved out
 * of OrderPage as it was).
 */
import { useDeferredValue, useMemo, useState } from 'react';
import { normalizeQuery, rankNameLike } from '../../lib/searchMatch';
import { useAnnounce } from '../../hooks/useAnnounce';
import { useI18n, useProductName } from '../../hooks/useI18n';
import { groupCatalog, type GroupableCategory, type GroupableSku } from './catalogGroups';

export function useCatalogFilter<S extends GroupableSku & { names: Record<string, string> }>({
  skus,
  categories,
  loaded,
}: {
  /** What can be ordered (orderableSkus). */
  skus: S[];
  categories: ReadonlyArray<GroupableCategory & { names: Record<string, string> }> | undefined;
  /** The catalog has loaded: only then is a filter's result announced. */
  loaded: boolean;
}) {
  const i18n = useI18n();
  const productName = useProductName();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // M1.10 (2026-05-08): cross-language SKU search. Lives above the
  // category chip-bar; queries match across uz/ru/en/zh names + code.
  const [searchQuery, setSearchQuery] = useState('');
  // Perf (2026-11-05): the input shows every keystroke at once; the 300-row
  // list filters against this deferred copy, so React can paint the typed
  // character first and redo the list in the next, interruptible render.
  const deferredSearch = useDeferredValue(searchQuery);

  const filteredSkus = useMemo(() => {
    // Two filters compose: category chip + cross-language search.
    // Apply category first (cheap object-key compare) then search
    // (string match across 4 lang fields + code) so we walk the
    // smaller set on the second pass.
    let out = activeCategory ? skus.filter((s) => s.categoryId === activeCategory) : skus;
    // Ranked: best match first, the reader's language breaking ties, typo
    // matches only when nothing matched literally (lib/searchMatch).
    out = rankNameLike(
      out,
      normalizeQuery(deferredSearch),
      (s) => ({ names: s.names, code: s.code }),
      i18n.locale,
    );
    return out;
  }, [skus, activeCategory, deferredSearch, i18n.locale]);
  // A11Y-12 (2026-10-31): say how many products the search / category
  // leaves, once typing settles; the list used to change in silence.
  useAnnounce(
    loaded && (deferredSearch.trim() || activeCategory)
      ? filteredSkus.length === 0
        ? i18n.t('order.search.noMatches.title')
        : i18n.t('a11y.results.products', { n: filteredSkus.length })
      : null,
  );
  // DX-ORD-6 (2026-11-01): grouped by category in the admin's order.
  const catalogGroups = useMemo(
    () =>
      // While searching, one list in relevance order — category groups would
      // scatter the best match below whole groups of weaker ones.
      // Archived lines still in the draft keep their "No longer sold" group.
      deferredSearch.trim()
        ? [
            {
              key: 'search-archived',
              categoryId: null,
              archived: true,
              skus: filteredSkus.filter((s) => s.isArchived),
            },
            {
              key: 'search',
              categoryId: null,
              archived: false,
              skus: filteredSkus.filter((s) => !s.isArchived),
            },
          ].filter((g) => g.skus.length > 0)
        : groupCatalog(filteredSkus, categories ?? [], { archivedFirst: true }),
    [filteredSkus, categories, deferredSearch],
  );
  const categoryNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) {
      m.set(c.id, productName({ names: c.names }));
    }
    return m;
  }, [categories, productName]);

  /**
   * The "All" chip. M3.10 (2026-05-16): tapping "All" after a category
   * filter previously left any active search query in place. If the user
   * had typed "tomato" while looking at Fruits and then tapped All to
   * "reset", the search still filtered the (now-broader) list and they
   * often saw an empty result with no obvious way to clear. Clearing
   * search alongside the category reset matches the natural "show me
   * everything" intent.
   */
  const showAll = () => {
    setActiveCategory(null);
    setSearchQuery('');
  };

  return {
    searchQuery,
    setSearchQuery,
    /** What the list is filtered by (lags typing slightly). */
    deferredSearch,
    activeCategory,
    setActiveCategory,
    showAll,
    filteredSkus,
    catalogGroups,
    categoryNameById,
  };
}
