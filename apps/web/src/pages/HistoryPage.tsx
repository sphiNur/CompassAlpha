/**
 * HistoryPage — purchase history as a top-level destination.
 *
 * 2026-07-30. Before this, `RunHistoryPage` existed but was reachable
 * exactly one way: scroll to the bottom of the Run tab, find the
 * history card, tap "全部历史". Two problems with that.
 *
 *   1. It was buried. The run page is the purchaser's working surface
 *      — in-flight rows, price entry, per-store splits — and history
 *      sat underneath all of it. Looking up what a store spent last
 *      month meant scrolling past the work you were mid-way through.
 *
 *   2. It was invisible to everyone who isn't a purchaser. The Run tab
 *      is gated on `run.purchase`, held only by the purchaser role
 *      (plus admins, who hold everything). A store manager could not
 *      reach purchase history at all — not because the data was
 *      restricted, but because the only door to it was inside a room
 *      they aren't allowed into.
 *
 * Worth stating plainly: the API never had this restriction.
 * `run.history` is an `authedProcedure` that scopes rows by store —
 * `run.create.org` holders see the whole org, everyone else sees the
 * stores they're actually assigned to (`getActorStoreIds`). So the
 * gate was purely a front-end accident of where the link lived, and
 * opening it up needs no server change: a manager querying this
 * endpoint already got exactly their own stores back.
 *
 * The tab is gated on `prices.view` (purchaser + manager + admin +
 * super_admin). History is a price-and-spend record, so that is the
 * permission it should follow; it also keeps rank-20 staff — who hold
 * `order.draft`/`delivery.confirm` but no money permission — out of
 * org spend figures without inventing a new permission key.
 *
 * This file is only the data shell. Every pixel below the queries is
 * `RunHistoryPage`, unchanged, rendered without `onBack` (a tab has
 * nothing to go back to).
 */
import { useMemo } from 'react';
import { trpc } from '../lib/trpc';
import { useI18n, useProductName } from '../hooks/useI18n';
import { RunHistoryPage } from './runs/history/RunHistory';

export function HistoryPage() {
  const i18n = useI18n();
  const productName = useProductName();

  // Same three queries RunPage ran to feed the drill page. They are
  // separate query keys from RunPage's, but react-query dedupes by key
  // across components, so a purchaser switching Run ↔ History pays for
  // catalog.skus / catalog.stores once, not twice.
  const historyQuery = trpc.run.history.useQuery();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const storesQuery = trpc.catalog.stores.useQuery();

  // Archived SKUs are included deliberately: a run from three months
  // ago can reference a SKU that has since been archived, and without
  // it the row renders as a bare id. (`includeArchived: false` above
  // mirrors RunPage; see the note in the detail sheet — it falls back
  // to the id rather than crashing, which is the pre-existing
  // behaviour on the drill page and not something this move changes.)
  const skuById = useMemo(() => {
    const m = new Map<
      string,
      { id: string; names: Record<string, string>; unit: string; step: string; categoryId: string | null }
    >();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
        categoryId: sku.categoryId ?? null,
      });
    }
    return m;
  }, [skusQuery.data]);

  const storeById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; code: string | null }>();
    for (const store of storesQuery.data ?? []) m.set(store.id, store);
    return m;
  }, [storesQuery.data]);

  return (
    <RunHistoryPage
      runs={historyQuery.data ?? []}
      loading={historyQuery.isLoading}
      storeById={storeById}
      skuById={skuById}
      productName={productName}
      i18n={i18n}
    />
  );
}
