/**
 * The store picker and the store chip.
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
 *
 *   2026-11-11  (review NEW-08) Only the picker and the chip live here.
 *               useStoreContext and useCanSeeStorePicker are in
 *               hooks/useStoreContext.ts, the switch rule and the guards
 *               in lib/storeContext.ts: pages and hooks imported them from
 *               this component file.
 */
import { useState } from 'react';
import { cn, SectionLabel, PickerGroup, PickerRow, Sheet, useToast } from '@compass/ui';
import { useAuthStore, ALL_STORES } from '../stores/authStore';
import type { StoreContext } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { NO_STORES, useCanSeeStorePicker, useStoreContext } from '../hooks/useStoreContext';
import { requestStoreChange } from '../lib/storeContext';

/**
 * Inline picker rendered INSIDE the Settings sheet. No trigger button,
 * no nested sheet — the rows themselves are the picker UI. On selection
 * the caller's `onClose` runs so the Settings sheet can dismiss too.
 *
 * Renders nothing if the actor may not switch (canSwitchStore). The Settings parent
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
  const toast = useToast();
  const isOrgAdmin = session?.permissions.includes('org.admin') ?? false;

  if (!canSee) return null;

  const stores = session?.stores ?? [];
  const chooseStore = (nextStoreId: StoreContext) => {
    if (nextStoreId === currentStoreId) {
      onClose();
      return;
    }
    void (async () => {
      if (!(await requestStoreChange(nextStoreId))) return;
      setCurrentStore(nextStoreId);
      onClose();
      // DX-SHL-4 (2026-11-01): the page behind changed with no word; say
      // which store is now on screen (the toast is also read out).
      const name =
        nextStoreId === ALL_STORES
          ? i18n.t('storeSwitcher.allOrgStores')
          : (stores.find((st) => st.id === nextStoreId)?.name ?? '');
      if (name) toast.success(i18n.t('storeSwitcher.switched', { store: name }));
    })();
  };

  return (
    <section>
      {showLabel ? (
        <SectionLabel as="h3" padded={false} className="mb-2">
          {i18n.t('storeSwitcher.title')}
        </SectionLabel>
      ) : null}
      <PickerGroup label={i18n.t('storeSwitcher.title')}>
        {isOrgAdmin ? (
          <PickerRow
            label={i18n.t('storeSwitcher.allOrgStores')}
            hint={i18n.t('storeSwitcher.allOrgHint')}
            selected={currentStoreId === ALL_STORES}
            onClick={() => chooseStore(ALL_STORES)}
          />
        ) : null}
        {stores.map((store) => (
          <PickerRow
            key={store.id}
            label={store.name}
            hint={store.code ?? ''}
            selected={currentStoreId === store.id}
            onClick={() => chooseStore(store.id)}
          />
        ))}
      </PickerGroup>
    </section>
  );
}

/**
 * The current-store pill for a page's sticky bar.
 *
 * Renders for every actor — knowing which store you're acting on is
 * context, not a privilege. Tappable only when the actor may switch
 * (`org.admin`, or ≥2 assigned stores — CA-22); otherwise it's a plain label with no affordance, so
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
   * pill at `text-old-label` (11px) this sat between Telegram's Close and
   * ⋯ — solid dark pills roughly twice its height, white glyphs, high
   * contrast — and read as a stray app widget dropped into the title
   * bar rather than the screen's title. It is also the single most
   * load-bearing piece of context on the page ("which store am I
   * ordering for") rendered at the smallest type size in the frame.
   *
   * Telegram's own rule is the one to follow: the buttons flanking the
   * bar are pills, the bot title between them is plain text. So: no
   * fill, no ring, `text-old-body` semibold at full `--c-fg`. The ▾ stays
   * for actors who can switch — it is the only remaining hint that the
   * title is tappable, so it carries that weight alone now.
   *
   * `min-w-0 truncate` + `shrink` so a long store name truncates
   * instead of pushing into either chrome button.
   */
  // V4: hit-44 — the title is 18 px tall; it taps as 44.
  const shell = 'hit-44 inline-flex min-w-0 shrink items-center gap-1 text-old-body font-semibold';

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
        // Review COREWEB1-25 (2026-11-11): the name is the reason the chip
        // is there; "change store" alone hid it from a screen reader, and
        // a label must contain the visible text (WCAG 2.5.3).
        aria-label={i18n.t('storeSwitcher.aria', { name: label })}
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
