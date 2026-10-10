import { useState } from 'react';
import { List, Row, Sheet, StatusChip } from '@compass/ui/kit';
import { ALL_STORES, useAuthStore } from '../stores/authStore';
import type { AuthSession, StoreContext } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import {
  requestStoreChange,
  useCanSeeStorePicker,
  useStoreContext,
} from '../components/StoreSwitcher';

const NO_STORES: AuthSession['stores'] = [];

/**
 * The top of every screen: which store the person is acting for, and,
 * for those who work across stores, the one place to change it.
 *
 * Inside Telegram this strip is space Telegram's own Close and menu
 * buttons already float over, so the store name sits centred between
 * them, on their row. In a plain browser there is nothing to clear and
 * it is an ordinary 44px bar with the name at the page margin.
 */
export function StoreBar({ inTelegram }: { inTelegram: boolean }) {
  if (inTelegram) {
    // Both sides are padded by the WIDER of Telegram's two overlays, which
    // keeps the name on the screen's centre line rather than centred in
    // the uneven gap between them.
    const side = 'max(var(--app-chrome-pad-left, 16px), var(--app-chrome-pad-right, 16px))';
    return (
      <div
        className="flex shrink-0 items-center justify-center bg-neutral"
        style={{
          height: 'var(--app-chrome-reserve, calc(var(--app-safe-top) + 36px))',
          paddingTop: 'var(--app-chrome-safe-top, 0px)',
          paddingLeft: side,
          paddingRight: side,
        }}
      >
        <StoreButton />
      </div>
    );
  }
  return (
    <header
      className="flex shrink-0 items-center border-b border-line bg-surface px-page"
      style={{ paddingTop: 'var(--app-safe-top)' }}
    >
      <StoreButton />
    </header>
  );
}

function StoreButton() {
  const i18n = useI18n();
  const ctx = useStoreContext();
  const canSwitch = useCanSeeStorePicker();
  const stores = useAuthStore((s) => s.session?.stores ?? NO_STORES);
  const currentStoreId = useAuthStore((s) => s.currentStoreId);
  const setCurrentStore = useAuthStore((s) => s.setCurrentStore);
  const [open, setOpen] = useState(false);

  if (ctx.kind === 'none') return <span className="h-tap" />;

  const label =
    ctx.kind === 'all'
      ? i18n.t('storeSwitcher.allOrgStores')
      : (stores.find((st) => st.id === ctx.storeId)?.name.trim() ??
        i18n.t('storeSwitcher.pickStore'));

  if (!canSwitch) {
    return (
      <span
        data-testid="current-store"
        className="flex h-tap min-w-0 items-center text-label text-ink"
      >
        <span className="truncate">{label}</span>
      </span>
    );
  }

  const choose = (next: StoreContext) => {
    if (next === currentStoreId) {
      setOpen(false);
      return;
    }
    void (async () => {
      // A screen with unsaved work can refuse the switch.
      if (!(await requestStoreChange(next))) return;
      setCurrentStore(next);
      setOpen(false);
    })();
  };
  const current = <StatusChip tone="done">{i18n.t('storeSwitcher.current')}</StatusChip>;
  const selectedId = ctx.kind === 'all' ? ALL_STORES : ctx.storeId;

  return (
    <>
      <button
        type="button"
        data-testid="current-store"
        aria-label={i18n.t('storeSwitcher.aria')}
        onClick={() => setOpen(true)}
        className="flex h-tap min-w-0 items-center gap-xs text-label text-ink outline-none active:opacity-60"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="shrink-0 text-secondary">
          ▾
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={i18n.t('storeSwitcher.title')} keepFocus>
        <List>
          <Row
            title={i18n.t('storeSwitcher.allOrgStores')}
            detail={i18n.t('storeSwitcher.allOrgHint')}
            value={selectedId === ALL_STORES ? current : undefined}
            onPress={() => choose(ALL_STORES)}
          />
          {stores.map((store) => (
            <Row
              key={store.id}
              title={store.name}
              value={selectedId === store.id ? current : undefined}
              onPress={() => choose(store.id)}
            />
          ))}
        </List>
      </Sheet>
    </>
  );
}
