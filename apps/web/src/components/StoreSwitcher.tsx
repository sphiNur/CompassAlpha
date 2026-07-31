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
 *
 *   2026-07-30  (flow review) `StoreChip` — a pill back in the sticky bar,
 *               but this time it is primarily a LABEL, not a trigger.
 *
 *               M3.5 moved the picker into Settings on the grounds that
 *               only the owner needs to switch. That reasoning holds for
 *               the *switching*; what it took with it was the only place
 *               the app ever said WHICH STORE you are working in. Walking
 *               the flow on 2026-07-30, the current store appeared nowhere
 *               across Order / Approval / Run / Confirm / Admin — I only
 *               learned which store I'd been ordering for by reading it
 *               off an approval card. Combine that with a picker two taps
 *               deep in Telegram's ⋯ overflow and a selection persisted to
 *               localStorage, and an owner who switched to another store
 *               last week orders into it all day without a single cue.
 *
 *               So the chip shows for EVERYONE (context is not a
 *               privilege), and only becomes tappable for `org.admin` —
 *               who get the picker in a sheet the chip owns, rather than
 *               being sent to Settings to hunt for it.
 */
import { useState } from 'react';
import { cn, SectionLabel, PickerRow, Sheet } from '@compass/ui';
import { useAuthStore, ALL_STORES } from '../stores/authStore';
import type { AuthSession, StoreContext } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';

/**
 * Module-level empty array for the `stores` selector below.
 *
 * Why this exists: zustand compares selector output with `Object.is` and
 * feeds it to `useSyncExternalStore`. A selector that ends in `?? []`
 * mints a FRESH array on every call, so the snapshot always looks
 * "changed" — React re-renders, re-reads, sees another new array, and
 * loops until it throws `Maximum update depth exceeded` out of
 * `forceStoreRerender`. That crash was observed once while navigating
 * Run → Confirm (both pages call useStoreContext) on 2026-07-30.
 *
 * Returning the SAME frozen reference every time keeps the snapshot
 * stable when `session` is null or `session.stores` is undefined.
 */
const NO_STORES: AuthSession['stores'] = [];

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
export function StorePickerSection({
  onClose,
  showLabel = true,
}: {
  onClose: () => void;
  /**
   * The section heading. On by default because this component was built to
   * sit among OTHER sections inside SettingsSheet, where it needs to name
   * itself. StoreChip renders it in a sheet whose title already says
   * "当前门店", so it passes false rather than printing the phrase twice.
   */
  showLabel?: boolean;
}) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const currentStoreId = useAuthStore((s) => s.currentStoreId);
  const setCurrentStore = useAuthStore((s) => s.setCurrentStore);
  const canSee = useCanSeeStorePicker();

  if (!canSee) return null;

  const stores = session?.stores ?? [];

  return (
    <section>
      {showLabel ? (
        <SectionLabel as="h3" padded={false} className="mb-2">
          {i18n.t('storeSwitcher.title')}
        </SectionLabel>
      ) : null}
      <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
        <PickerRow
          label={i18n.t('storeSwitcher.allOrgStores')}
          hint={i18n.t('storeSwitcher.allOrgHint')}
          selected={currentStoreId === ALL_STORES}
          onClick={() => {
            setCurrentStore(ALL_STORES);
            onClose();
          }}
        />
        {stores.map((store) => (
          <PickerRow
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

/**
 * The current-store pill for a page's sticky bar.
 *
 * Renders for every actor — knowing which store you're acting on is
 * context, not a privilege. Tappable only when the actor may switch
 * (`org.admin`); otherwise it's a plain label with no affordance, so
 * nobody taps something that can't respond.
 *
 * Returns null when there is no store context to state at all (`kind:
 * 'none'` — the actor has no assignments; those pages already render a
 * dedicated empty state that explains it).
 */
export function StoreChip({ className }: { className?: string } = {}) {
  const i18n = useI18n();
  const ctx = useStoreContext();
  const canSwitch = useCanSeeStorePicker();
  const stores = useAuthStore((s) => s.session?.stores ?? NO_STORES);
  const [open, setOpen] = useState(false);

  if (ctx.kind === 'none') return null;

  const label =
    ctx.kind === 'all'
      ? i18n.t('storeSwitcher.allOrgStores')
      : (stores.find((st) => st.id === ctx.storeId)?.name.trim() ??
        i18n.t('storeSwitcher.pickStore'));

  /**
   * Styled as a TITLE, not a control.
   *
   * 2026-07-30, from Telegram screenshots: as a pale `--c-surface-2`
   * pill at `text-label` (11px) this sat between Telegram's Close and
   * ⋯ — solid dark pills roughly twice its height, white glyphs, high
   * contrast — and read as a stray app widget dropped into the title
   * bar rather than the screen's title. It is also the single most
   * load-bearing piece of context on the page ("which store am I
   * ordering for") rendered at the smallest type size in the frame.
   *
   * Telegram's own rule is the one to follow: the buttons flanking the
   * bar are pills, the bot title between them is plain text. So: no
   * fill, no ring, `text-body` semibold at full `--c-fg`. The ▾ stays
   * for actors who can switch — it is the only remaining hint that the
   * title is tappable, so it carries that weight alone now.
   *
   * `min-w-0 truncate` + `shrink` so a long store name truncates
   * instead of pushing into either chrome button.
   *
   * 2026-07-31 (capsule pass): still fill-less — Telegram's own bot
   * title is plain text and that is the whole point — but it now
   * reserves the capsule tier's height. Unlike Telegram's title ours
   * is TAPPABLE for org admins, and it was an 18px-tall touch target
   * sitting between two 32px chrome buttons.
   */
  const shell =
    'inline-flex min-h-[var(--capsule-h)] min-w-0 shrink items-center gap-1 text-body font-semibold';

  if (!canSwitch) {
    return (
      <span className={cn(shell, className)}>
        <span className="truncate text-[var(--c-fg)]">{label}</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={i18n.t('storeSwitcher.aria')}
        className={cn(shell, 'press active:opacity-60', className)}
      >
        <span className="truncate text-[var(--c-fg)]">{label}</span>
        <span aria-hidden className="shrink-0 text-[var(--c-fg-muted)]">
          ▾
        </span>
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={i18n.t('storeSwitcher.title')}
        description={i18n.t('storeSwitcher.subtitle')}
      >
        <div className="py-2">
          <StorePickerSection showLabel={false} onClose={() => setOpen(false)} />
        </div>
      </Sheet>
    </>
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
  // NO_STORES (module-level) — never `?? []` inline here. See the
  // constant's docblock: a fresh array per call loops useSyncExternalStore.
  const stores = useAuthStore((s) => s.session?.stores ?? NO_STORES);
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
