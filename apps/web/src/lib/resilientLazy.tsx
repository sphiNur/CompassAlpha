/**
 * RE-SHL-1 (2026-10-30): `React.lazy` keeps a failed import for good. A tab
 * first opened while offline failed to load its chunk, and once online
 * again neither the boundary's Retry nor switching tabs helped — only a
 * full reload (closing the Mini App). Here a failed import resolves to a
 * small placeholder instead, which imports again when the connection
 * returns or on Retry and renders the real page — or, as browsers also
 * cache a failed import, reloads once the network is back.
 */
import { lazy, useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { Button, EmptyState } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';

type PageModule<P> = { default: ComponentType<P> };

export function resilientLazy<P extends object>(factory: () => Promise<PageModule<P>>) {
  return lazy(() =>
    factory().catch(() => ({
      default: function PageNotLoaded(props: P) {
        const i18n = useI18n();
        const [Page, setPage] = useState<ComponentType<P> | null>(null);
        const [busy, setBusy] = useState(false);
        const retry = useCallback(() => {
          setBusy(true);
          factory()
            .then((m) => setPage(() => m.default))
            .catch(() => {
              // Browsers keep a failed module import for that URL too, so
              // a second import() can fail although the network is back.
              // Online, a reload is what actually fetches it again.
              if (navigator.onLine) window.location.reload();
            })
            .finally(() => setBusy(false));
        }, []);
        useEffect(() => {
          window.addEventListener('online', retry);
          return () => window.removeEventListener('online', retry);
        }, [retry]);
        if (Page) return <Page {...props} />;
        return (
          <div className="px-4 py-6">
            <EmptyState
              title={i18n.t('shell.pageNotLoaded.title')}
              description={i18n.t('shell.pageNotLoaded.body')}
              action={
                <Button loading={busy} onClick={retry}>
                  {i18n.t('common.retry')}
                </Button>
              }
            />
          </div>
        );
      },
    })),
  );
}
