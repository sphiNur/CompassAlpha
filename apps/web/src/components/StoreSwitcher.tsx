/**
 * Store-context plumbing — picker UI + state hooks.
 *
 * History
 *   2026-05-05  First version. Added a global pill button rendered in
 *               every page header so multi-store managers + admins could
 *               flip context. `useStoreSwitcherInteractive` decided
 *               per-render whether to show the pill.
 *   2026-05-15  (M3.5) Removed the top-of-page pill entirely. The
 *               typical CompassAlpha deployment has ONE owner + N
 *               single-store managers + staff, so the pill was useful
 *               only for the owner — who doesn't need it on every
 *               page when it can live in Settings. The picker is now
 *               an inline section inside SettingsSheet, gated on the
 *               `org.admin` permission. Non-admins (including single-
 *               store managers) never see it.
 *
 *               State source unchanged — `useAuthStore.currentStoreId`.
 *               `useStoreContext()` (consumed by AdminPage and other
 *               readers) is unchanged; only the trigger UX moved.
 */
import { useAuthStore, ALL_STORES } from '../stores/authStore';
import type { StoreContext } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';

/**
 * True iff the actor is allowed to see + use the store picker.
 *
 * M3.5 rule: only `org.admin` holders (super_admin, admin, and any
 * future org-tier custom role) can switch context. Manager (rank 60,
 * store-tier) holds `users.manage` but NOT `org.admin`, so they no
 * longer see the picker — consistent with their store-bound role.
 *
 * If a multi-store-tier role ever needs the picker (e.g., regional
 * purchaser bound to N stores), grant them `org.admin` explicitly or
 * relax this check to also include `stores.length >= 2`.
 */
export function useCanSeeStorePicker(): boolean {
  const session = useAuthStore((s) => s.session);
  return session?.permissions.includes('org.admin') ?? false;
}

/**
 * Inline picker rendered INSIDE the Settings sheet. No trigger button,
 * no nested sheet — the rows themselves are the picker UI. On selection
 * the caller's `onClose` runs so the Settings sheet can dismiss too.
 *
 * Renders nothing if the actor lacks `org.admin`. The Settings parent
 * can also skip rendering this section by checking `useCanSeeStorePicker`
 * first; this internal early-return is belt-and-suspenders so a mis-call
 * from a non-admin context never leaks the chrome.
 */
export function StorePickerSection({ onClose }: { onClose: () => void }) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const currentStoreId = useAuthStore((s) => s.currentStoreId);
  const setCurrentStore = useAuthStore((s) => s.setCurrentStore);
  const canSee = useCanSeeStorePicker();

  if (!canSee) return null;

  const stores = session?.stores ?? [];

  return (
    <section>
      <h3 className="mb-2 text-label font-semibold uppercase tracking-eyebrow text-[var(--c-fg-muted)]">
        🏪 {i18n.t('storeSwitcher.title')}
      </h3>
      <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
        <SwitcherRow
          label={i18n.t('storeSwitcher.allOrgStores')}
          hint={i18n.t('storeSwitcher.allOrgHint')}
          selected={currentStoreId === ALL_STORES}
          onClick={() => {
            setCurrentStore(ALL_STORES);
            onClose();
          }}
        />
        {stores.map((store) => (
          <SwitcherRow
            key={store.id}
            label={store.name}
            hint={store.code ?? ''}
            selected={currentStoreId === store.id}
            onClick={() => {
              setCurrentStore(store.id);
              onClose();
            }}
          />
        ))}
      </div>
    </section>
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
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left ' +
        (selected
          ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
          : 'bg-[var(--c-surface)] active:opacity-80')
      }
    >
      <div className="min-w-0">
        <div className="truncate text-body font-semibold">{label}</div>
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
 *
 * NOTE (M3.5): "isAdmin" here still uses `users.manage` because the
 * decision is "should this user even see the noStore dead-end?" Both
 * org.admin and store-manager need to be steered into either a
 * specific store or 'all' — neither should land on `kind: 'none'`
 * just because they don't have an MSA row. (`users.manage` correctly
 * captures both.)
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
