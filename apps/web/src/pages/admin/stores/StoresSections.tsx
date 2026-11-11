/**
 * Admin → Stores sections — extracted verbatim from AdminPage.tsx
 * (Phase 5 step 3 of the 2026-07 frontend audit's admin split).
 *
 *   - StoresHomeSection  store tiles + create-store sheet
 *   - StoreDetailScreen  drilled-in store: Team | Settings | Inventory
 *                        | Sales tab router
 *   - StoreSettingsTab (internal); the Inventory tab is
 *     inventory/StoreInventoryTab (ADM2-11); the Sales tab
 *     renders the shared components/sales/StoreSalesPanel (CA-09)
 *   - StoreCloneRolesSheet clone-roles wizard (internal)
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataState,
  EmptyState,
  Field,
  FieldGroup,
  Input,
  LoadingState,
  Segmented,
  Select,
  Sheet,
  Switch,
  rowGroupClass,
  useToast,
  QueryErrorBanner,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts/schemas/roles';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../hooks/useErrToast';
import { useRefreshSession } from '../../../hooks/useRefreshSession';
import { rolePassesOn } from '../../../lib/authority';
import { useI18n, useRoleLabels } from '../../../hooks/useI18n';
import { nativeConfirm } from '../shared';
import type { StoreFocus, StoreSub } from '../../../stores/navStore';
import { PeopleSection } from '../people/PeopleSections';
import { StoreInventoryTab } from './inventory/StoreInventoryTab';
import { StoreSalesPanel } from '../../../components/sales/StoreSalesPanel';

interface StoreDraft {
  storeId?: string;
  name: string;
  code: string;
  address: string;
  timezone: string;
  isActive: boolean;
  /** D3 (2026-05-06): default role for new members invited into this
   *  store. Only relevant when editing an existing store; new stores
   *  default to '' (no default) and can be set after creation. */
  defaultRoleSlug: string;
}

// EMPTY_STORE was used by the old combined create/edit sheet; the
// store list now uses a small create-only sheet inline (just name +
// code + address + timezone — defaults set later in Settings tab).

// ============ Stores (M1.4 store-first) ============

/**
 * StoresHomeSection (M1.4, 2026-05-06).
 *
 * Top-level list of all stores the actor can administer, plus a
 * pseudo-store at the top that buckets org-level members (admin /
 * super_admin without store assignments). Each tile shows the store's
 * basic info, member count, and default role hint. Tap a tile → drill
 * into StoreDetailScreen.
 *
 * Why this replaced "Catalog → Stores":
 *   - Stores aren't catalog data; they're org structure.
 *   - The whole point of M1.4 is "store as the unit of nav" — staff
 *     management lives inside a store, not in a flat People list.
 *
 * Member count: derived FE-side from `admin.memberList`. We could add
 * a dedicated endpoint, but the member list is already cached for
 * other admin views and N here is small (≤ a few hundred members per
 * org for the foreseeable future).
 */
export function StoresHomeSection({
  onPickStore,
}: {
  onPickStore: (focus: StoreFocus) => void;
}) {
  // 2026-10-21 audit CA-08/CA-16: store create/archive/pause are
  // org.admin-only server-side, so gate the UI on the same flag. An
  // org.admin also lists paused stores (badge below) so one switched
  // off by mistake can be found and reactivated.
  const isOrgAdmin = useAuthStore(
    (s) => s.session?.permissions.includes('org.admin') ?? false,
  );
  const storesQuery = trpc.admin.storeList.useQuery({ includeArchived: isOrgAdmin });
  const membersQuery = trpc.admin.memberList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const refreshSession = useRefreshSession();
  // Lightweight create-only sheet: create flow needs name/code/address/
  // timezone but NOT default-role/archive (those land in Settings tab
  // after creation). Keeping it a sheet rather than inline because
  // creation is a transient one-shot, not edit-in-place.
  const [createDraft, setCreateDraft] = useState<{
    name: string;
    code: string;
    address: string;
    timezone: string;
  } | null>(null);

  const create = trpc.admin.storeCreate.useMutation({
    onSuccess: (data, vars) => {
      void utils.admin.storeList.invalidate();
      toast.success(i18n.t('admin.toast.storeCreated'));
      setCreateDraft(null);
      // 2026-10-21 FE-06: the session's stores / adminStoreIds feed the
      // invite, grant, transfer and clone pickers; refresh it so the new
      // store is pickable without reopening the app, then drill into the
      // new store so setup (default role, team) can continue right away.
      // Not awaited inside onSuccess: that would hold the mutation (and
      // the app-wide busy state) pending for an extra round trip.
      void refreshSession().then(() =>
        onPickStore({ kind: 'store', storeId: data.id, storeName: vars.name }),
      );
    },
    onError: errToast('common.errors.actionFailed'),
  });

  // Aggregate member counts per store from the cached memberList. A
  // paused store counts its people too; they are not org-level (ADM1-16).
  const memberCounts = useMemo(() => {
    const byStore = new Map<string, number>();
    let orgLevel = 0;
    for (const m of membersQuery.data ?? []) {
      const stores = [...m.stores, ...m.inactiveStores];
      if (stores.length === 0) {
        orgLevel++;
      } else {
        for (const st of stores) {
          byStore.set(st.id, (byStore.get(st.id) ?? 0) + 1);
        }
      }
    }
    return { byStore, orgLevel };
  }, [membersQuery.data]);

  return (
    <div className="px-4 py-3">
      {isOrgAdmin ? (
        <div className="mb-3">
          <Button
            size="sm"
            onClick={() =>
              setCreateDraft({ name: '', code: '', address: '', timezone: '' })
            }
          >
            + {i18n.t('admin.store.new')}
          </Button>
        </div>
      ) : null}
      <DataState
        query={storesQuery}
        emptyWhen={(d) => d.length === 0 && memberCounts.orgLevel === 0}
        empty={
          <EmptyState
            title={i18n.t('admin.store.emptyTitle')}
            description={i18n.t('admin.store.emptyBody')}
          />
        }
      >
        {(rows) => (
          // Review ADM2-12 (2026-11-11): the stores are rows of one card
          // (UI-6), each a flat <button>: block elements (<header><h3>)
          // inside a <button> are invalid HTML.
          <ul className={rowGroupClass} role="list">
            {/* Org-level pseudo-store (only if there are admin/super-
                admin members not in any store; otherwise skipped to
                avoid noise). */}
            {memberCounts.orgLevel > 0 ? (
              <li>
                {/* M1.21: store list row rhythm — py-3 matches member
                    cards above. Was py-4 (16 px each side), which felt
                    chunky relative to the rest of the admin surface. */}
                {/* M3.17: title text-old-h2 → text-old-h3 + font-semibold to
                    match the rest of the app's list-row primary text
                    rhythm. Was the only place admin shouted at h2. */}
                <button
                  type="button"
                  onClick={() => onPickStore({ kind: 'org-level' })}
                  className="press flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left"
                >
                  <span className="min-w-0">
                    <span className="block text-old-h3 font-semibold text-[var(--c-fg)]">
                      {i18n.t('admin.label.orgLevel')}
                    </span>
                    <span className="mt-0.5 block text-old-label text-[var(--c-fg-muted)]">
                      {i18n.t('admin.label.orgLevelHint')}
                    </span>
                  </span>
                  <Badge tone="muted">
                    {i18n.t('admin.label.memberCount', {
                      n: memberCounts.orgLevel,
                    })}
                  </Badge>
                </button>
              </li>
            ) : null}
            {rows.map((st) => {
              const count = memberCounts.byStore.get(st.id) ?? 0;
              return (
                <li key={st.id}>
                  {/* M1.11: Stores home tile slimmed from 3 muted-meta
                      info rows to one. Dropped: timezone (rarely
                      consulted from this view), default-role (lives in
                      the store-detail page), and the "view-only" tag
                      since the chevron action will reveal that anyway.
                      Kept: code (the primary identifier) + member
                      count. py-4 → py-3 to match the rest of the
                      member-card rhythm. */}
                  <button
                    type="button"
                    onClick={() =>
                      onPickStore({
                        kind: 'store',
                        storeId: st.id,
                        storeName: st.name,
                      })
                    }
                    className="press flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block text-old-h3 font-semibold text-[var(--c-fg)]">
                        {st.name}
                      </span>
                      <span className="mt-0.5 block text-old-label text-[var(--c-fg-muted)]">
                        {st.code
                          ? i18n.t('stores.codeLabel', { code: st.code })
                          : i18n.t('stores.noCode')}
                        {' · '}
                        {i18n.t('admin.label.memberCount', { n: count })}
                      </span>
                    </span>
                    {/* UIUX-B1: active is the silent default; only the
                        exception (paused) earns ink. */}
                    {!st.isActive ? (
                      <Badge tone="muted">
                        {i18n.t(st.archived ? 'stores.archived' : 'stores.paused')}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!createDraft}
        onOpenChange={(open) => !open && setCreateDraft(null)}
        // DX-IX-10: Esc / backdrop / Back ask before dropping what was typed.
        hasChanges={
          !!createDraft &&
          !create.isPending &&
          Object.values(createDraft).some((v) => v.trim() !== '')
        }
        title={i18n.t('admin.store.new')}
        footer={
          <Button
            block
            loading={create.isPending}
            disabled={!createDraft?.name.trim()}
            onClick={() => {
              if (!createDraft) return;
              create.mutate({
                name: createDraft.name,
                code: createDraft.code || null,
                address: createDraft.address || null,
                timezone: createDraft.timezone || null,
              });
            }}
          >
            {i18n.t('common.create')}
          </Button>
        }
      >
        {createDraft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label={i18n.t('admin.field.name')} required>
              <Input
                value={createDraft.name}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, name: e.target.value })
                }
                maxLength={200}
                autoFocus
              />
            </Field>
            <Field label={i18n.t('admin.field.code')}>
              <Input
                value={createDraft.code}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, code: e.target.value })
                }
                maxLength={32}
                placeholder={i18n.t('admin.field.codePlaceholder')}
              />
            </Field>
            <Field label={i18n.t('admin.field.address')}>
              <Input
                value={createDraft.address}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, address: e.target.value })
                }
                maxLength={500}
              />
            </Field>
            <Field label={i18n.t('admin.field.timezone')}>
              <Input
                value={createDraft.timezone}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, timezone: e.target.value })
                }
                maxLength={64}
                placeholder={i18n.t('admin.field.timezonePlaceholder')}
              />
            </Field>
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('admin.store.createHint')}
            </p>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

/**
 * StoreDetailScreen (M1.4, 2026-05-06).
 *
 * Per-store detail page. Tab bar at the top:
 *   - Team — members in this store, with all the Manage / Grant /
 *            Permissions / Detach / Transfer affordances. Reuses the
 *            existing PeopleSection with `lockMode` set so the global
 *            StoreSwitcher is bypassed.
 *   - Settings — store fields (name/code/address/timezone), default
 *                role picker, archive button, clone-roles wizard.
 *
 * Org-level focus: only Team tab. Settings doesn't apply (the pseudo-
 * store has no DB row).
 */
export function StoreDetailScreen({
  focus,
  sub,
  onSubChange,
  onLeave,
}: {
  focus: NonNullable<StoreFocus>;
  sub: StoreSub;
  onSubChange: (s: StoreSub) => void;
  /** Back to the store list (ADM2-22: offered when the store is gone). */
  onLeave: () => void;
}) {
  const i18n = useI18n();
  const isOrgLevel = focus.kind === 'org-level';
  const effectiveSub: StoreSub = isOrgLevel ? 'team' : sub;
  return (
    <div className="flex flex-col">
      {!isOrgLevel ? (
        // M3.17 (2026-05-16): Team / Inventory / Sales / Settings tabs
        // migrated from local SegBtn → shared <Segmented>. M2.0a +
        // M2.0c notes preserved: Inventory shows on-hand + stocktake,
        // Sales records dish sales (auto-deducts via recipe BOM).
        <div className="px-4 pb-1 pt-1">
          <Segmented<StoreSub>
            value={effectiveSub}
            options={[
              { value: 'team', label: i18n.t('admin.store.tabTeam') },
              { value: 'inventory', label: i18n.t('admin.store.tabInventory') },
              { value: 'sales', label: i18n.t('admin.store.tabSales') },
              { value: 'settings', label: i18n.t('admin.store.tabSettings') },
            ]}
            onChange={onSubChange}
            ariaLabel={i18n.t('admin.store.sectionAria')}
          />
        </div>
      ) : null}
      {effectiveSub === 'team' ? (
        <PeopleSection
          lockMode={
            isOrgLevel
              ? { kind: 'org-level' }
              : { kind: 'store', storeId: focus.storeId }
          }
        />
      ) : null}
      {effectiveSub === 'inventory' && focus.kind === 'store' ? (
        <StoreInventoryTab storeId={focus.storeId} />
      ) : null}
      {effectiveSub === 'sales' && focus.kind === 'store' ? (
        <StoreSalesPanel storeId={focus.storeId} className="px-4 py-3" />
      ) : null}
      {effectiveSub === 'settings' && focus.kind === 'store' ? (
        <StoreSettingsTab storeId={focus.storeId} onLeave={onLeave} />
      ) : null}
    </div>
  );
}

/**
 * StoreSettingsTab (M1.4, 2026-05-06).
 *
 * Inline edit form for a single store. Reuses the same underlying
 * mutations the old `StoresSection` modal sheet did (storeUpdate /
 * storeDelete / storeCloneRoles), but rendered as a flat form on the
 * Settings tab — no sheet, no modal — because we're already inside a
 * dedicated detail screen.
 */
function StoreSettingsTab({ storeId, onLeave }: { storeId: string; onLeave: () => void }) {
  const session = useAuthStore((s) => s.session);
  // 2026-10-21 audit CA-08/CA-16: pause/reactivate, archive and clone-
  // roles are org.admin-only server-side. Replaces the isGlobalAdmin
  // heuristic, which counted a single-store manager as global.
  const isOrgAdmin = session?.permissions.includes('org.admin') ?? false;
  // Same input as StoresHomeSection so a paused store (org.admin only)
  // resolves here instead of spinning on "Loading store…".
  const storesQuery = trpc.admin.storeList.useQuery({ includeArchived: isOrgAdmin });
  const rolesQuery = trpc.admin.roleList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const refreshSession = useRefreshSession();
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );

  const store = useMemo(
    () => (storesQuery.data ?? []).find((s) => s.id === storeId) ?? null,
    [storesQuery.data, storeId],
  );

  const [draft, setDraft] = useState<StoreDraft | null>(null);
  // D4 clone-roles wizard target. Always pre-fills the current store
  // as the TARGET; operator picks a source from their other admin
  // stores in the sheet.
  const [cloneOpen, setCloneOpen] = useState(false);

  // Hydrate draft when the store row arrives or the storeId changes.
  useEffect(() => {
    if (!store) return;
    setDraft({
      storeId: store.id,
      name: store.name,
      code: store.code ?? '',
      address: store.address ?? '',
      timezone: store.timezone ?? '',
      isActive: store.isActive,
      defaultRoleSlug: store.defaultRoleSlug ?? '',
    });
  }, [store]);

  const update = trpc.admin.storeUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.success(i18n.t('admin.toast.storeUpdated'));
      // 2026-10-21 FE-06: name / active state live in session.stores too.
      void refreshSession();
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const remove = trpc.admin.storeDelete.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.info(i18n.t('admin.toast.storeArchived'));
      // 2026-10-21 FE-06: drop the archived store from session pickers.
      void refreshSession();
    },
    onError: errToast('common.errors.actionFailed'),
  });

  // ADM-5: the default is a grant by whoever sets it, and the server
  // refuses a role at or above the actor's rank in this store. List only
  // what they could set (same estimate as the grant sheet), plus the
  // current value so the picker can still show it.
  const myStoreRank = Math.max(session?.myMaxRank ?? 0, session?.storeRanks?.[storeId] ?? 0);
  const currentDefault = store?.defaultRoleSlug ?? null;
  // DX-ADM-1: a custom role with a key the actor lacks in this store
  // (D8) stays visible, greyed, with the reason, unless it is the
  // current value.
  const storeTierRoles = useMemo(
    () =>
      [...(rolesQuery.data ?? [])]
        .filter((r) => r.rank < ADMIN_RANK && (r.rank < myStoreRank || r.slug === currentDefault))
        .map((r) => ({
          ...r,
          keysMissing: r.slug !== currentDefault && !rolePassesOn(r, { type: 'store', storeId }),
        }))
        .sort((a, b) => Number(a.keysMissing) - Number(b.keysMissing) || b.rank - a.rank),
    [rolesQuery.data, myStoreRank, currentDefault, storeId],
  );

  // ADM2-22 (2026-11-11): a failed load, or a store missing from the list
  // (archived since, or no longer this person's; the open store survives
  // a restart), spun on "Loading store…" for good.
  if (!store || !draft) {
    return (
      // Inset like the form it stands in for (and the other tabs).
      <div className="px-4 py-3">
        <DataState
          query={storesQuery}
          emptyWhen={() => !store}
          empty={
            <EmptyState
              title={i18n.t('admin.store.unavailableTitle')}
              description={i18n.t('admin.store.unavailableBody')}
              action={
                <Button variant="pearl" onClick={onLeave}>
                  {i18n.t('admin.store.backToList')}
                </Button>
              }
            />
          }
        >
          {/* Found: the form fills in from it on the next render. */}
          {() => null}
        </DataState>
      </div>
    );
  }

  const dirty =
    draft.name !== (store.name ?? '') ||
    draft.code !== (store.code ?? '') ||
    draft.address !== (store.address ?? '') ||
    draft.timezone !== (store.timezone ?? '') ||
    draft.isActive !== store.isActive ||
    draft.defaultRoleSlug !== (store.defaultRoleSlug ?? '');

  // org.admin also administers paused stores, which adminStoreIds omits.
  const canAdmin = isOrgAdmin || adminStoreIds.has(storeId);

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Field label={i18n.t('admin.field.name')} required>
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          maxLength={200}
          disabled={!canAdmin}
        />
      </Field>
      <Field label={i18n.t('admin.field.code')}>
        <Input
          value={draft.code}
          onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          maxLength={32}
          placeholder={i18n.t('admin.field.codePlaceholder')}
          disabled={!canAdmin}
        />
      </Field>
      <Field label={i18n.t('admin.field.address')}>
        <Input
          value={draft.address}
          onChange={(e) => setDraft({ ...draft, address: e.target.value })}
          maxLength={500}
          disabled={!canAdmin}
        />
      </Field>
      <Field label={i18n.t('admin.field.timezone')}>
        <Input
          value={draft.timezone}
          onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          maxLength={64}
          placeholder={i18n.t('admin.field.timezonePlaceholder')}
          disabled={!canAdmin}
        />
      </Field>
      {rolesQuery.isError && !rolesQuery.data ? (
        // ADM2-22 (2026-11-11): without the roles the picker read "no
        // default", whatever the store's default is. A group, not a
        // <label>: inside one, the Retry button took the whole field's
        // text as its name, and a tap anywhere on the field pressed it.
        <FieldGroup
          label={i18n.t('admin.field.defaultRole')}
          hint={i18n.t('admin.store.defaultRoleHint')}
        >
          <QueryErrorBanner query={rolesQuery} />
        </FieldGroup>
      ) : (
        <Field
          label={i18n.t('admin.field.defaultRole')}
          hint={i18n.t('admin.store.defaultRoleHint')}
        >
          {rolesQuery.isLoading ? (
            <LoadingState variant="inline" label={i18n.t('admin.label.loadingRoles')} />
          ) : (
            <Select
              value={draft.defaultRoleSlug}
              onChange={(e) => setDraft({ ...draft, defaultRoleSlug: e.target.value })}
              disabled={!canAdmin}
            >
              <option value="">{i18n.t('admin.store.noDefaultRole')}</option>
              {storeTierRoles.map((r) => (
                <option key={r.id} value={r.slug} disabled={r.keysMissing}>
                  {r.keysMissing
                    ? i18n.t('people.roleNameKeysYouLack', { name: roleText.name(r) })
                    : i18n.t('people.roleNameWithRank', { name: roleText.name(r), rank: r.rank })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {isOrgAdmin ? (
        <Switch
          label={i18n.t('admin.label.active')}
          checked={draft.isActive}
          onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
        />
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-[var(--c-divider)] pt-4">
        <Button
          loading={update.isPending}
          disabled={!canAdmin || !dirty || !draft.name.trim()}
          onClick={() => {
            update.mutate({
              storeId: draft.storeId!,
              name: draft.name,
              code: draft.code || null,
              address: draft.address || null,
              timezone: draft.timezone || null,
              // Only org.admin may send isActive (CA-08); others omit it.
              ...(isOrgAdmin ? { isActive: draft.isActive } : {}),
              defaultRoleSlug: draft.defaultRoleSlug
                ? draft.defaultRoleSlug
                : null,
            });
          }}
        >
          {i18n.t('common.save')}
        </Button>
        {/* M1.9: clone-roles requires global admin (was canAdmin + ≥2
            admin stores; per-store managers shouldn't trigger this
            org-wide write). 2026-10-21: org.admin, as the server checks. */}
        {isOrgAdmin && adminStoreIds.size >= 2 ? (
          <Button
            variant="pearl"
            onClick={() => setCloneOpen(true)}
          >
            {i18n.t('admin.action.cloneRoles')}
          </Button>
        ) : null}
        {isOrgAdmin ? (
          <Button
            variant="danger-ghost"
            onClick={async () => {
              // ADM-18 (2026-10-30): say what is still open at the store.
              const impact = await utils.admin.storeArchiveImpact
                .fetch({ storeId })
                .catch(() => null);
              const busy = impact && (impact.openOrders > 0 || impact.activeRuns > 0);
              nativeConfirm(
                busy
                  ? i18n.t('admin.store.confirmArchiveBusy', {
                      name: store.name,
                      orders: impact.openOrders,
                      runs: impact.activeRuns,
                    })
                  : i18n.t('admin.store.confirmArchive', { name: store.name }),
                () => remove.mutate({ storeId }),
              );
            }}
          >
            {i18n.t('common.archive')}
          </Button>
        ) : null}
      </div>
      {!canAdmin ? (
        <Banner tone="info" title={i18n.t('admin.label.readOnly')}>
          {i18n.t('admin.store.readOnlyBody')}
        </Banner>
      ) : null}

      {cloneOpen ? (
        <StoreCloneRolesSheet
          target={{ targetStoreId: storeId, targetStoreName: store.name }}
          onClose={() => setCloneOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * StoreCloneRolesSheet (D4, 2026-05-06).
 *
 * Wizard for "open Store C with the same team shape as Store A".
 * Reads the actor's adminStoreIds for the source-store dropdown — a
 * store-scoped manager can only clone FROM stores they administer.
 * Server enforces the same gate.
 *
 * The "include members" toggle defaults OFF: most chain expansion
 * wants the role SHAPE replicated but staffed by different people.
 * Turn it on for "I'm splitting Store A's team across two new stores"
 * scenarios.
 */
function StoreCloneRolesSheet({
  target,
  onClose,
}: {
  target: { targetStoreId: string; targetStoreName: string } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = useMemo(() => session?.stores ?? [], [session?.stores]);
  const open = !!target;

  const [sourceStoreId, setSourceStoreId] = useState('');
  const [includeMembers, setIncludeMembers] = useState(false);

  useEffect(() => {
    if (target) {
      setSourceStoreId('');
      setIncludeMembers(false);
    }
  }, [target]);

  const sourceCandidates = useMemo(() => {
    if (!target) return [];
    return sessionStores.filter(
      (st) => adminStoreIds.has(st.id) && st.id !== target.targetStoreId,
    );
  }, [sessionStores, adminStoreIds, target]);

  const cloneMut = trpc.admin.storeCloneRoles.useMutation({
    onSuccess: (data) => {
      void utils.admin.storeList.invalidate();
      void utils.admin.memberList.invalidate();
      // D7: without "also members" only the default role travels.
      const parts =
        data.cloned > 0 || includeMembers
          ? [i18n.t('admin.clone.toastCloned', { n: data.cloned })]
          : [];
      if (data.defaultRoleCopied) parts.push(i18n.t('admin.clone.toastDefaultRole'));
      if (data.skippedExisting > 0)
        parts.push(
          i18n.t('admin.clone.toastAlreadyExisted', { n: data.skippedExisting }),
        );
      if (data.skippedRank > 0)
        parts.push(i18n.t('admin.clone.toastSkippedRank', { n: data.skippedRank }));
      if (data.skippedPermission > 0)
        parts.push(i18n.t('admin.clone.toastSkippedPermission', { n: data.skippedPermission }));
      if (parts.length === 0) parts.push(i18n.t('admin.clone.toastCloned', { n: 0 }));
      if (data.assigned > 0) parts.push(i18n.t('admin.clone.toastAssigned', { n: data.assigned }));
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: errToast('common.errors.actionFailed'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !cloneMut.isPending && onClose()}
      title={i18n.t('admin.clone.title')}
      description={
        target ? i18n.t('admin.clone.target', { store: target.targetStoreName }) : ''
      }
      footer={
        target ? (
          <Button
            block
            size="lg"
            loading={cloneMut.isPending}
            disabled={!sourceStoreId}
            onClick={() =>
              cloneMut.mutate({
                sourceStoreId,
                targetStoreId: target.targetStoreId,
                includeMembers,
              })
            }
          >
            {i18n.t('admin.clone.action')}
          </Button>
        ) : undefined
      }
    >
      {target ? (
        <div className="flex flex-col gap-3 py-3">
          <Field label={i18n.t('admin.field.sourceStore')} required>
            {sourceCandidates.length === 0 ? (
              <Banner tone="warn" title={i18n.t('admin.clone.noSourceTitle')}>
                {i18n.t('admin.clone.noSourceBody')}
              </Banner>
            ) : (
              <Select
                value={sourceStoreId}
                onChange={(e) => setSourceStoreId(e.target.value)}
              >
                <option value="">{i18n.t('stores.pickSourceStore')}</option>
                {sourceCandidates.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {/* Review ADM2-12 / ADM2-33 (2026-11-11): the kit checkbox, not a
              native box on a grey card. */}
          <Checkbox
            checked={includeMembers}
            onChange={(e) => setIncludeMembers(e.target.checked)}
            label={i18n.t('admin.clone.alsoMembers')}
            hint={i18n.t('admin.clone.alsoMembersHint')}
          />
          <Banner tone="info" title={i18n.t('admin.clone.whatTitle')}>
            {i18n.t('admin.clone.whatBody', { store: target.targetStoreName })}
          </Banner>
        </div>
      ) : null}
    </Sheet>
  );
}

