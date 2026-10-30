/**
 * Admin → Stores sections — extracted verbatim from AdminPage.tsx
 * (Phase 5 step 3, FRONTEND_AUDIT_2026-07.md admin split).
 *
 *   - StoresHomeSection  store tiles + create-store sheet
 *   - StoreDetailScreen  drilled-in store: Team | Settings | Inventory
 *                        | Sales tab router
 *   - StoreInventoryTab / StoreSettingsTab (internal); the Sales tab
 *     renders the shared components/sales/StoreSalesPanel (CA-09)
 *   - StoreCloneRolesSheet clone-roles wizard (internal)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  Segmented,
  Select,
  Sheet,
  Spinner,
  Switch,
  useToast,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts';
import { newIdempotencyKey, trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { useRefreshSession } from '../../../lib/refreshSession';
import { formatQty } from '../../../lib/format';
import { useDateFormat, useI18n, useProductName, useUnitLabel } from '../../../hooks/useI18n';
import { nativeConfirm, type StoreFocus, type StoreSub } from '../shared';
import { PeopleSection } from '../people/PeopleSections';
import { StoreSalesPanel } from '../../../components/sales/StoreSalesPanel';
import {
  knownMovementReason,
  signedDelta,
  skusWithoutLevel,
  type MovementReason,
} from './inventoryHelpers';

/** 2026-10-21: localized label per ledger reason (movements sheet). */
const MOVEMENT_REASON_LABEL = {
  delivery_received: 'inventory.reason.delivery_received',
  stocktake: 'inventory.reason.stocktake',
  wastage: 'inventory.reason.wastage',
  consumption: 'inventory.reason.consumption',
  consumption_reversed: 'inventory.reason.consumption_reversed',
  transfer_in: 'inventory.reason.transfer_in',
  transfer_out: 'inventory.reason.transfer_out',
  adjustment: 'inventory.reason.adjustment',
} as const satisfies Record<MovementReason, string>;

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
    onError: errToast('common.error'),
  });

  // Aggregate member counts per store from the cached memberList.
  const memberCounts = useMemo(() => {
    const byStore = new Map<string, number>();
    let orgLevel = 0;
    for (const m of membersQuery.data ?? []) {
      if (m.stores.length === 0) {
        orgLevel++;
      } else {
        for (const st of m.stores) {
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
          <ul className="flex flex-col gap-2" role="list">
            {/* Org-level pseudo-store (only if there are admin/super-
                admin members not in any store; otherwise skipped to
                avoid noise). */}
            {/* Tiles are flat <button>s rather than <Card> wrappers
                because nesting block elements (<header><h3>) inside a
                <button> is invalid HTML — Chrome's parser hoists them
                out and splits the click target. We replicate the Card
                visual instead. */}
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
                  className="press flex w-full items-start justify-between gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-2.5 text-left ring-hairline"
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
                    className="press flex w-full items-start justify-between gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-2.5 text-left ring-hairline"
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
                    {!st.isActive ? <Badge tone="muted">{i18n.t('stores.paused')}</Badge> : null}
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
            <Field label={`${i18n.t('admin.field.name')} *`}>
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
                placeholder="optional internal code"
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
                placeholder="e.g. Asia/Tashkent"
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
}: {
  focus: NonNullable<StoreFocus>;
  sub: StoreSub;
  onSubChange: (s: StoreSub) => void;
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
        <StoreSalesPanel storeId={focus.storeId} />
      ) : null}
      {effectiveSub === 'settings' && focus.kind === 'store' ? (
        <StoreSettingsTab storeId={focus.storeId} />
      ) : null}
    </div>
  );
}

/**
 * StoreInventoryTab (M2.0a, 2026-05-08).
 *
 * Lists current on-hand per SKU at this store, sourced from the
 * `inventory.movements` ledger via `inventory.levels(storeId)`. Two
 * actions per row:
 *
 *   - Stocktake: type the count from the shelf. We compute the delta
 *     and post a single ledger row.
 *   - Wastage: subtract qty with a mandatory note (spoiled / broken /
 *     mislabeled / lost).
 *
 * Recent-movements drill-down for "why is the on-hand X" lives on
 * the row tap (opens a sheet listing the last 50 movements) — wired
 * 2026-10-21; the comment promised it long before the UI had it.
 *
 * 2026-10-21: "Add stocktake for another SKU" posts an opening count
 * for an active SKU with no ledger row here yet (a new store had no way
 * to start its inventory except waiting for a delivery).
 */
function StoreInventoryTab({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  // 2026-07-30 (flow review): on-hand quantities printed the raw canonical
  // unit while the rest of the app printed the localized label.
  const unitLabel = useUnitLabel();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const dateFmt = useDateFormat();
  const levelsQuery = trpc.inventory.levels.useQuery({ storeId });
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const utils = trpc.useUtils();
  // 2026-10-21 audit CA-16: mirror the server's requireInventoryAdjust
  // exactly — read-only members saw both buttons and got a 403 on save.
  // CA-10/CA-57: the users.manage fallback is gone on both sides
  // (migration 0048 backfilled manager → inventory.adjust).
  const canAdjust = useAuthStore(
    (s) => s.session?.permissions.includes('inventory.adjust') ?? false,
  );

  const skuById = useMemo(() => {
    const m = new Map<
      string,
      { id: string; names: Record<string, string>; unit: string; step: string }
    >();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
      });
    }
    return m;
  }, [skusQuery.data]);

  type ActionMode =
    // `pickSku`: opening stocktake — the SKU is chosen inside the sheet.
    | { kind: 'stocktake'; skuId: string; current: string; pickSku?: boolean }
    | { kind: 'wastage'; skuId: string };

  const [action, setAction] = useState<ActionMode | null>(null);
  // 2026-10-21: movements drill-down for one level row.
  const [movementsFor, setMovementsFor] = useState<{ skuId: string; name: string } | null>(null);
  const movementsQuery = trpc.inventory.recentMovements.useQuery(
    { storeId, skuId: movementsFor?.skuId ?? '' },
    { enabled: movementsFor !== null },
  );
  const [draftTarget, setDraftTarget] = useState('');
  const [draftWasteQty, setDraftWasteQty] = useState('');
  const [draftNote, setDraftNote] = useState('');

  // 2026-10-21 audit CA-54: one stable idempotency key per logical
  // wastage entry — minted when the sheet (re)arms, reused across
  // retries of the same submit, rotated after success. Same shape as
  // the sales form below. NOTE: the header is only sent once
  // 'inventory.recordWastage' is in lib/trpc.ts IDEMPOTENT_MUTATIONS.
  const wastageIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  useEffect(() => {
    wastageIdemCtx.idempotencyKey = newIdempotencyKey();
  }, [wastageIdemCtx, action, draftWasteQty, draftNote]);

  useEffect(() => {
    if (!action) {
      setDraftTarget('');
      setDraftWasteQty('');
      setDraftNote('');
    } else if (action.kind === 'stocktake') {
      setDraftTarget(action.current);
    }
  }, [action]);

  const stocktake = trpc.inventory.stocktake.useMutation({
    onSuccess: () => {
      void utils.inventory.levels.invalidate({ storeId });
      void utils.inventory.recentMovements.invalidate({ storeId });
      toast.success(i18n.t('inventory.toast.stocktakeSaved'));
      setAction(null);
    },
    onError: errToast('common.error'),
  });
  const recordWastage = trpc.inventory.recordWastage.useMutation({
    trpc: { context: wastageIdemCtx },
    onSuccess: () => {
      wastageIdemCtx.idempotencyKey = newIdempotencyKey();
      void utils.inventory.levels.invalidate({ storeId });
      void utils.inventory.recentMovements.invalidate({ storeId });
      toast.success(i18n.t('inventory.toast.wastageSaved'));
      setAction(null);
    },
    onError: errToast('common.error'),
  });

  const rows = useMemo(() => {
    const levels = levelsQuery.data ?? [];
    return levels.map((l) => {
      const sku = skuById.get(l.skuId);
      const name = sku ? productName({ names: sku.names }) : l.skuId.slice(0, 8);
      const unit = sku?.unit ?? '';
      const onHandNum = Number(l.onHand);
      return {
        skuId: l.skuId,
        name,
        unit,
        onHand: l.onHand,
        onHandNum,
        lastMovementAt: l.lastMovementAt,
      };
    });
  }, [levelsQuery.data, skuById, productName]);

  // 2026-10-21: active SKUs with no ledger row here — opening-stock picks.
  const openingCandidates = useMemo(
    () =>
      skusWithoutLevel([...skuById.values()], levelsQuery.data ?? [])
        .map((sku) => ({ id: sku.id, name: productName({ names: sku.names }) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [skuById, levelsQuery.data, productName],
  );

  return (
    <div className="px-4 py-3">
      {canAdjust && !levelsQuery.isLoading && openingCandidates.length > 0 ? (
        <div className="mb-3 flex">
          <Button
            size="sm"
            variant="pearl"
            className="ml-auto"
            onClick={() =>
              setAction({ kind: 'stocktake', skuId: '', current: '0', pickSku: true })
            }
          >
            {i18n.t('inventory.action.addStocktake')}
          </Button>
        </div>
      ) : null}
      {levelsQuery.isLoading ? (
        <div className="py-6 text-center">
          <Spinner size={16} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={i18n.t('inventory.empty.title')}
          description={i18n.t('inventory.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-1" role="list">
          {rows
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => {
              const stockedOut = r.onHandNum <= 0;
              return (
                <li
                  key={r.skuId}
                  className={
                    'rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline ' +
                    (stockedOut ? 'opacity-70' : '')
                  }
                >
                  {/* 2026-10-21: tap → recent movements sheet. */}
                  <button
                    type="button"
                    className="flex w-full items-baseline justify-between gap-2 text-left active:opacity-80"
                    onClick={() => setMovementsFor({ skuId: r.skuId, name: r.name })}
                  >
                    <span className="truncate text-old-body font-semibold">{r.name}</span>
                    <span className="font-mono text-old-body tabular-nums">
                      {formatQty(r.onHand)} {unitLabel(r.unit)}
                    </span>
                  </button>
                  {/* M3.17 (2026-05-16): inline pill buttons → Button
                      size="sm" with pearl + danger-ghost variants.
                      Stocktake is a neutral edit; wastage is a real
                      reduce-stock action so the danger-ghost tone is
                      appropriate (red text, no fill — same level as
                      Archive elsewhere). */}
                  {canAdjust ? (
                    <div className="mt-1 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="pearl"
                        onClick={() =>
                          setAction({
                            kind: 'stocktake',
                            skuId: r.skuId,
                            current: r.onHand,
                          })
                        }
                      >
                        {i18n.t('inventory.action.stocktake')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={() => setAction({ kind: 'wastage', skuId: r.skuId })}
                      >
                        {i18n.t('inventory.action.wastage')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
        </ul>
      )}

      {/* Stocktake / wastage editor sheet. */}
      <Sheet
        open={action !== null}
        onOpenChange={(open) => !open && setAction(null)}
        title={
          action?.kind === 'stocktake'
            ? i18n.t('inventory.sheet.stocktake.title')
            : i18n.t('inventory.sheet.wastage.title')
        }
        description={
          action && action.skuId
            ? productName({ names: skuById.get(action.skuId)?.names ?? {} })
            : ''
        }
        footer={
          // 2026-07-30: dropped `!getTg() &&` — same defect as the dish
          // editor. `getTg()` is truthy in any browser (the Telegram SDK
          // is a static script tag), and nothing drives the native
          // MainButton for this sheet, so stocktake / wastage had no
          // submit button in any environment. See the CatalogSections
          // dish-editor footer for the full write-up.
          action ? (
            <Button
              block
              loading={stocktake.isPending || recordWastage.isPending}
              disabled={!action.skuId}
              onClick={() => {
                if (!action || !action.skuId) return;
                if (action.kind === 'stocktake') {
                  stocktake.mutate({
                    storeId,
                    skuId: action.skuId,
                    target: draftTarget,
                    note: draftNote.trim() || undefined,
                  });
                } else {
                  if (!draftNote.trim()) {
                    errToast('common.error')(new Error('inventory.errors.wastageNeedsNote'));
                    return;
                  }
                  recordWastage.mutate({
                    storeId,
                    skuId: action.skuId,
                    qty: draftWasteQty,
                    note: draftNote.trim(),
                  });
                }
              }}
            >
              {i18n.t('common.save')}
            </Button>
          ) : null
        }
      >
        {action ? (
          <div className="flex flex-col gap-3 py-3">
            {action.kind === 'stocktake' ? (
              <>
                {action.pickSku ? (
                  <Field label={i18n.t('inventory.sheet.stocktake.skuLabel')}>
                    <Select
                      value={action.skuId}
                      aria-label={i18n.t('inventory.sheet.stocktake.skuLabel')}
                      onChange={(e) => setAction({ ...action, skuId: e.target.value })}
                    >
                      <option value="">{i18n.t('inventory.sheet.stocktake.pickSku')}</option>
                      {openingCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('inventory.sheet.stocktake.systemSays', {
                    qty: formatQty(action.current),
                  })}
                </div>
                <Field
                  label={i18n.t('inventory.sheet.stocktake.targetLabel')}
                  hint={i18n.t('inventory.sheet.stocktake.targetHint')}
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={skuById.get(action.skuId)?.step ?? '0.1'}
                    min="0"
                    value={draftTarget}
                    onChange={(e) => setDraftTarget(e.target.value)}
                    autoFocus
                  />
                </Field>
                <Field label={i18n.t('inventory.sheet.note')}>
                  <Input
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder={i18n.t('inventory.sheet.stocktake.notePlaceholder')}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={i18n.t('inventory.sheet.wastage.qtyLabel')}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={skuById.get(action.skuId)?.step ?? '0.1'}
                    min="0"
                    value={draftWasteQty}
                    onChange={(e) => setDraftWasteQty(e.target.value)}
                    autoFocus
                  />
                </Field>
                <Field
                  label={i18n.t('inventory.sheet.note')}
                  hint={i18n.t('inventory.sheet.wastage.noteHint')}
                >
                  <Input
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder={i18n.t('inventory.sheet.wastage.notePlaceholder')}
                  />
                </Field>
              </>
            )}
          </div>
        ) : null}
      </Sheet>

      {/* 2026-10-21: recent movements (last 50) for one SKU. */}
      <Sheet
        open={movementsFor !== null}
        onOpenChange={(open) => !open && setMovementsFor(null)}
        title={i18n.t('inventory.movements.title')}
        description={movementsFor?.name ?? ''}
      >
        {movementsFor ? (
          <div className="py-3">
            {movementsQuery.isLoading ? (
              <div className="py-6 text-center">
                <Spinner size={16} />
              </div>
            ) : (movementsQuery.data ?? []).length === 0 ? (
              <EmptyState title={i18n.t('inventory.movements.empty')} />
            ) : (
              <ul className="flex flex-col gap-1" role="list">
                {(movementsQuery.data ?? []).map((m) => {
                  const known = knownMovementReason(m.reason);
                  const { sign, abs } = signedDelta(m.delta);
                  const unit = skuById.get(movementsFor.skuId)?.unit ?? '';
                  return (
                    <li
                      key={m.id}
                      className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-old-body font-medium">
                          {known ? i18n.t(MOVEMENT_REASON_LABEL[known]) : m.reason}
                        </span>
                        <span
                          className={
                            'font-mono text-old-body tabular-nums ' +
                            (sign === '-' ? 'text-[var(--c-danger)]' : '')
                          }
                        >
                          {sign}
                          {formatQty(abs)} {unitLabel(unit)}
                        </span>
                      </div>
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {dateFmt.dateTime(m.occurredAt)}
                        {m.note ? ` · ${m.note}` : ''}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </Sheet>
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
function StoreSettingsTab({ storeId }: { storeId: string }) {
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
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.storeDelete.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.info(i18n.t('admin.toast.storeArchived'));
      // 2026-10-21 FE-06: drop the archived store from session pickers.
      void refreshSession();
    },
    onError: errToast('common.error'),
  });

  const storeTierRoles = useMemo(
    () =>
      [...(rolesQuery.data ?? [])]
        .filter((r) => r.rank < ADMIN_RANK)
        .sort((a, b) => b.rank - a.rank),
    [rolesQuery.data],
  );

  if (storesQuery.isLoading || !draft || !store) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-old-body-sm text-[var(--c-fg-muted)]">
        <Spinner size={14} /> Loading store…
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
      <Field label={`${i18n.t('admin.field.name')} *`}>
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
          placeholder="optional internal code"
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
          placeholder="e.g. Asia/Tashkent"
          disabled={!canAdmin}
        />
      </Field>
      <Field label={i18n.t('admin.field.defaultRole')}>
        {rolesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-old-body-sm text-[var(--c-fg-muted)]">
            <Spinner size={14} /> Loading roles…
          </div>
        ) : (
          <Select
            value={draft.defaultRoleSlug}
            onChange={(e) =>
              setDraft({ ...draft, defaultRoleSlug: e.target.value })
            }
            disabled={!canAdmin}
          >
            <option value="">{i18n.t('admin.store.noDefaultRole')}</option>
            {storeTierRoles.map((r) => (
              <option key={r.id} value={r.slug}>
                {i18n.t('people.roleNameWithRank', { name: r.name, rank: r.rank })}
              </option>
            ))}
          </Select>
        )}
        <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('admin.store.defaultRoleHint')}
        </p>
      </Field>
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
            onClick={() =>
              nativeConfirm(
                i18n.t('admin.store.confirmArchive', { name: store.name }),
                () => remove.mutate({ storeId }),
              )
            }
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
  const sessionStores = session?.stores ?? [];
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
      const parts = [i18n.t('admin.clone.toastCloned', { n: data.cloned })];
      if (data.skippedExisting > 0)
        parts.push(
          i18n.t('admin.clone.toastAlreadyExisted', { n: data.skippedExisting }),
        );
      if (data.skippedRank > 0)
        parts.push(i18n.t('admin.clone.toastSkippedRank', { n: data.skippedRank }));
      if (data.assigned > 0)
        parts.push(i18n.t('admin.clone.toastAssigned', { n: data.assigned }));
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: errToast('common.error'),
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
          <Field label={`${i18n.t('admin.field.sourceStore')} *`}>
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
          <label className="press flex cursor-pointer items-start gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={includeMembers}
              onChange={(e) => setIncludeMembers(e.target.checked)}
            />
            <div className="min-w-0 flex-1">
              <div className="text-old-body font-semibold text-[var(--c-fg)]">
                {i18n.t('admin.clone.alsoMembers')}
              </div>
              <p className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('admin.clone.alsoMembersHint')}
              </p>
            </div>
          </label>
          <Banner tone="info" title={i18n.t('admin.clone.whatTitle')}>
            {i18n.t('admin.clone.whatBody', { store: target.targetStoreName })}
          </Banner>
        </div>
      ) : null}
    </Sheet>
  );
}

