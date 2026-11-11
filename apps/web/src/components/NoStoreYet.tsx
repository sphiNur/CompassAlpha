/**
 * AUTH-17 (2026-10-30): a brand-new workspace has no store. Its owner
 * landed on 下单 being told to "tap the store chip at the top" (there is
 * none to pick) and on 日结 being told they lack the permission. Say what
 * is missing and take them to Admin › Stores to create one.
 */
import { Button, EmptyState } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import { useStoreContext } from '../hooks/useStoreContext';
import { useAuthStore } from '../stores/authStore';
import { requestTabChange, useNavStore } from '../stores/navStore';

/** True for an org admin whose organisation has no store yet. */
export function useNoStoreYet(): boolean {
  return useAuthStore(
    (s) => !!s.session && s.session.stores.length === 0 && s.session.permissions.includes('org.admin'),
  );
}

export function NoStoreYet() {
  const i18n = useI18n();
  const setTab = useNavStore((s) => s.setTab);
  const setAdminSection = useNavStore((s) => s.setAdminSection);
  return (
    <EmptyState
      title={i18n.t('auth.noStoreYet.title')}
      description={i18n.t('auth.noStoreYet.body')}
      action={
        <Button
          onClick={() => {
            void requestTabChange('admin').then((allowed) => {
              if (!allowed) return;
              setAdminSection('stores');
              setTab('admin');
            });
          }}
        >
          {i18n.t('auth.noStoreYet.action')}
        </Button>
      }
    />
  );
}

/**
 * What a page that works on one store shows without one: a new
 * workspace's admin is sent to create a store, a member with no store is
 * told so, and an admin looking at all stores is asked to pick one. On
 * the page's 16 px gutter (UI-12).
 *
 * Review COREWEB1-22 (2026-11-12): the three branches were written out in
 * the order, receiving, sales and attendance pages, with different
 * margins; the order page's touched the screen edges.
 */
export function StoreContextEmpty() {
  const i18n = useI18n();
  const storeCtx = useStoreContext();
  const noStoreYet = useNoStoreYet();
  return (
    <div className="px-4 pb-4 pt-3">
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
