/**
 * SalesPage — bottom-tab home for sales entry (2026-10-21).
 *
 * Built-in staff hold `sales.record` but not `settlement.record`, so the
 * only sales surface (the collapsible block on the Settlement page, CA-09)
 * was out of their reach. Shell shows this tab only to users WITHOUT
 * settlement.record; everyone else keeps using the Settlement block so the
 * bottom nav doesn't grow a sixth item for them.
 *
 * Renders the shared StoreSalesPanel for the current store context.
 *
 * Review COREWEB1-23 (2026-11-11): no visible title. A tab page is named
 * by the bottom nav and Shell's hidden <h1> (UI-12); the store it showed
 * under the title is the top bar's store chip.
 */
import { StoreSalesPanel } from '../components/sales/StoreSalesPanel';
import { StoreContextEmpty } from '../components/NoStoreYet';
import { useStoreContext } from '../hooks/useStoreContext';

export function SalesPage() {
  const storeCtx = useStoreContext();

  // Sales are one store's: no store, or all of them, says why.
  if (storeCtx.kind !== 'specific') return <StoreContextEmpty />;

  return (
    <div className="flex flex-col px-4 pb-4 pt-3">
      {/* Keyed by store so a half-picked dish never carries over a switch. */}
      <StoreSalesPanel key={storeCtx.storeId} storeId={storeCtx.storeId} />
    </div>
  );
}
