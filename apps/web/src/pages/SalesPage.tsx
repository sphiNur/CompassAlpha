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
 */
import { EmptyState, PageHeader } from '@compass/ui';
import { StoreSalesPanel } from '../components/sales/StoreSalesPanel';
import { NoStoreYet, useNoStoreYet } from '../components/NoStoreYet';
import { useStoreContext } from '../components/StoreSwitcher';
import { useI18n } from '../hooks/useI18n';
import { useAuthStore } from '../stores/authStore';

export function SalesPage() {
  const i18n = useI18n();
  const storeCtx = useStoreContext();
  const noStoreYet = useNoStoreYet();
  const storeName = useAuthStore((s) =>
    storeCtx.kind === 'specific'
      ? (s.session?.stores.find((store) => store.id === storeCtx.storeId)?.name ?? null)
      : null,
  );

  if (storeCtx.kind !== 'specific') {
    // Same empty states as Order / Confirm: no assignment at all, or an
    // org admin on the all-stores context who must pick one store.
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {noStoreYet ? (
          <NoStoreYet />
        ) : storeCtx.kind === 'none' ? (
          <EmptyState
            title={i18n.t('auth.noStore.title')}
            description={i18n.t('auth.noStore.body')}
          />
        ) : (
          <EmptyState
            title={i18n.t('storeSwitcher.pickPrompt.title')}
            description={i18n.t('storeSwitcher.pickPrompt.body')}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-4">
      <PageHeader title={i18n.t('sales.page.title')} subtitle={storeName ?? undefined} />
      {/* Keyed by store so a half-picked dish never carries over a switch. */}
      <StoreSalesPanel key={storeCtx.storeId} storeId={storeCtx.storeId} />
    </div>
  );
}
