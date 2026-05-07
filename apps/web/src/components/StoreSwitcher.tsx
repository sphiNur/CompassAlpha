/**
 * StoreSwitcher — global "which store am I looking at?" picker.
 *
 * Why this exists (2026-05-05).
 *
 *   The earlier UX assumed every user has exactly one store, with a
 *   silent `currentStoreId` in the auth store. Three problems that
 *   surfaced once we audited:
 *
 *   1. Multi-store managers had no way to flip context. They saw their
 *      first-assigned store and got stuck unless we navigated them
 *      around manually.
 *   2. Super-admins always saw "all org" data, which the user found
 *      confusing — a chain owner watching staff submit orders wants to
 *      know "I'm looking at Store A" most of the time, with an explicit
 *      "show me everything" mode for cross-store reports.
 *   3. The Approval queue's local store-filter chip was solving the
 *      same problem in a sub-page, divorced from the rest of the app.
 *      Better: lift it into one app-wide control.
 *
 * Design — a small pill button that lives in each page's header next
 * to the title (no global app chrome — Telegram WebApp owns the very
 * top of the screen). Tap → sheet with the store list. The component
 * decides itself whether to render anything:
 *
 *   - User has 0 stores: render nothing (the page itself shows
 *     auth.noStore copy in that case).
 *   - User has 1 store and is NOT admin: render a non-tappable label
 *     with the store name (so the user can SEE what they're looking
 *     at, but there's nothing to switch).
 *   - User has 2+ stores OR is admin: tappable pill with chevron.
 *     The picker sheet adds an "All my stores" option. For admins, the
 *     option is "All stores in org" since they see everything.
 *
 * State source — `useAuthStore.currentStoreId` (which is now a
 * discriminated union, see authStore.ts ALL_STORES sentinel). The
 * setter persists to localStorage automatically via zustand-persist.
 */
import { useState, useMemo } from 'react';
import { Sheet, Button } from '@compass/ui';
import { useAuthStore, ALL_STORES } from '../stores/authStore';
import type { StoreContext } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';

/**
 * Returns true when the StoreSwitcher will render an interactive pill
 * (i.e., the user actually has a choice to make). Single-store
 * non-admins get a static label that consumes 32+ px of chrome for
 * zero interaction value — pages should hide the entire sticky
 * context strip in that case (M1.13, 2026-05-08).
 */
export function useStoreSwitcherInteractive(): boolean {
  const session = useAuthStore((s) => s.session);
  const stores = session?.stores ?? [];
  const isAdmin = session?.permissions.includes('users.manage') ?? false;
  if (stores.length === 0 && !isAdmin) return false;
  // Single store, non-admin: switcher renders static. Hide.
  if (!isAdmin && stores.length === 1) return false;
  return true;
}

export function StoreSwitcher() {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const currentStoreId = useAuthStore((s) => s.currentStoreId);
  const setCurrentStore = useAuthStore((s) => s.setCurrentStore);
  const [open, setOpen] = useState(false);

  const stores = session?.stores ?? [];
  const isAdmin = session?.permissions.includes('users.manage') ?? false;
  const canSelectAll = isAdmin || stores.length >= 2;

  // Resolve the label to show in the pill. For 'ALL' we localize the
  // sentinel; for a specific id we look up the name.
  const label = useMemo(() => {
    if (currentStoreId === ALL_STORES) {
      return isAdmin
        ? i18n.t('storeSwitcher.allOrgStores')
        : i18n.t('storeSwitcher.allMyStores');
    }
    if (currentStoreId) {
      const found = stores.find((s) => s.id === currentStoreId);
      if (found) return found.name;
    }
    return i18n.t('storeSwitcher.pickStore');
  }, [currentStoreId, stores, isAdmin, i18n]);

  // Hide if the user has no stores at all — the page-level
  // "no store assigned" empty state takes over.
  if (stores.length === 0 && !isAdmin) return null;

  // Single-store non-admin: just show a static label. No tap target,
  // no chevron — there's nothing to choose.
  const isStatic = !canSelectAll && stores.length === 1;

  return (
    <>
      <button
        type="button"
        onClick={isStatic ? undefined : () => setOpen(true)}
        disabled={isStatic}
        aria-label={i18n.t('storeSwitcher.aria')}
        className={
          'flex h-7 max-w-[160px] shrink-0 items-center gap-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-2.5 text-label ' +
          (isStatic ? 'cursor-default opacity-80' : 'active:opacity-70')
        }
      >
        <span aria-hidden className="text-tiny">🏪</span>
        <span className="min-w-0 truncate">{label}</span>
        {!isStatic ? <span aria-hidden className="text-tiny opacity-60">▾</span> : null}
      </button>

      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={i18n.t('storeSwitcher.title')}
        description={i18n.t('storeSwitcher.subtitle')}
      >
        <ul className="flex flex-col gap-1 py-3" role="list">
          {canSelectAll ? (
            <SwitcherRow
              label={
                isAdmin
                  ? i18n.t('storeSwitcher.allOrgStores')
                  : i18n.t('storeSwitcher.allMyStores')
              }
              hint={
                isAdmin
                  ? i18n.t('storeSwitcher.allOrgHint')
                  : i18n.t('storeSwitcher.allMyHint')
              }
              selected={currentStoreId === ALL_STORES}
              onClick={() => {
                setCurrentStore(ALL_STORES);
                setOpen(false);
              }}
            />
          ) : null}
          {stores.map((store) => (
            <SwitcherRow
              key={store.id}
              label={store.name}
              hint={store.code ?? ''}
              selected={currentStoreId === store.id}
              onClick={() => {
                setCurrentStore(store.id);
                setOpen(false);
              }}
            />
          ))}
        </ul>
        <div className="px-4 pb-2">
          <Button block variant="pearl" onClick={() => setOpen(false)}>
            {i18n.t('common.cancel')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function SwitcherRow({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={
          'flex w-full items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left ' +
          (selected
            ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
            : 'bg-[var(--c-surface-2)] active:opacity-80')
        }
      >
        <div className="min-w-0">
          <div className="truncate text-h3 font-semibold">{label}</div>
          {hint ? (
            <div
              className={
                'mt-0.5 truncate text-label ' +
                (selected ? 'opacity-80' : 'text-[var(--c-fg-muted)]')
              }
            >
              {hint}
            </div>
          ) : null}
        </div>
        {selected ? <span aria-hidden>✓</span> : null}
      </button>
    </li>
  );
}

/**
 * Hook helper — does the current page need a specific store?
 *
 * Returns:
 *   - { kind: 'specific', storeId } — caller can use storeId directly
 *   - { kind: 'all' } — page should aggregate; if it can't, show pick-prompt
 *   - { kind: 'none' } — user has no store assignments at all
 *
 * Centralizes the "what's our store context right now" logic so each
 * page doesn't reinvent the discriminated-union check.
 */
export function useStoreContext():
  | { kind: 'specific'; storeId: string }
  | { kind: 'all' }
  | { kind: 'none' } {
  const currentStoreId = useAuthStore((s) => s.currentStoreId);
  const stores = useAuthStore((s) => s.session?.stores ?? []);
  const isAdmin = useAuthStore((s) =>
    s.session?.permissions.includes('users.manage') ?? false,
  );
  if (currentStoreId === ALL_STORES) return { kind: 'all' };
  if (typeof currentStoreId === 'string') return { kind: 'specific', storeId: currentStoreId };
  // null path. If the user has stores but hasn't picked one yet (rare —
  // setSession auto-picks first), treat as "all" for read pages and let
  // write pages prompt to pick. If they have NO stores AND aren't admin,
  // it's the noStore dead-end.
  if (stores.length === 0 && !isAdmin) return { kind: 'none' };
  return { kind: 'all' };
}

export type { StoreContext };
