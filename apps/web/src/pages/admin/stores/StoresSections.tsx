/**
 * Admin → Stores sections — extracted verbatim from AdminPage.tsx
 * (Phase 5 step 3, FRONTEND_AUDIT_2026-07.md admin split).
 *
 *   - StoresHomeSection  store tiles + create-store sheet
 *   - StoreDetailScreen  drilled-in store: Team | Settings | Inventory
 *                        | Sales tab router
 *   - StoreInventoryTab / StoreSalesTab / StoreSettingsTab (internal)
 *   - StoreCloneRolesSheet clone-roles wizard (internal)
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Segmented,
  Select,
  Sheet,
  Spinner,
  Switch,
  useToast,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { formatMoney, formatQty } from '../../../lib/format';
import { useI18n, useProductName } from '../../../hooks/useI18n';
import { getTg } from '../../../hooks/useTelegram';
import { nativeConfirm, type StoreFocus, type StoreSub } from '../shared';
import { PeopleSection } from '../people/PeopleSections';

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
  const storesQuery = trpc.admin.storeList.useQuery();
  const membersQuery = trpc.admin.memberList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
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
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.success(i18n.t('admin.toast.storeCreated'));
      setCreateDraft(null);
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
      <div className="mb-3">
        <Button
          size="sm"
          onClick={() =>
            setCreateDraft({ name: '', code: '', address: '', timezone: '' })
          }
        >
          + New store
        </Button>
      </div>
      <DataState
        query={storesQuery}
        emptyWhen={(d) => d.length === 0 && memberCounts.orgLevel === 0}
        empty={
          <EmptyState
            title="No stores"
            description="Create one with the button above to start onboarding your team."
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
                {/* M3.17: title text-h2 → text-h3 + font-semibold to
                    match the rest of the app's list-row primary text
                    rhythm. Was the only place admin shouted at h2. */}
                <button
                  type="button"
                  onClick={() => onPickStore({ kind: 'org-level' })}
                  className="press flex w-full items-start justify-between gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-2.5 text-left ring-hairline"
                >
                  <span className="min-w-0">
                    <span className="block text-h3 font-semibold text-[var(--c-fg)]">
                      {i18n.t('admin.label.orgLevel')}
                    </span>
                    <span className="mt-0.5 block text-label text-[var(--c-fg-muted)]">
                      {i18n.t('admin.label.orgLevelHint')}
                    </span>
                  </span>
                  <Badge tone="muted">
                    {memberCounts.orgLevel}{' '}
                    {memberCounts.orgLevel === 1 ? 'member' : 'members'}
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
                      <span className="block text-h3 font-semibold text-[var(--c-fg)]">
                        {st.name}
                      </span>
                      <span className="mt-0.5 block text-label text-[var(--c-fg-muted)]">
                        {st.code ? `code ${st.code}` : 'no code'}
                        {' · '}
                        {count} {count === 1 ? 'member' : 'members'}
                      </span>
                    </span>
                    <Badge tone={st.isActive ? 'success' : 'muted'}>
                      {st.isActive ? 'active' : 'paused'}
                    </Badge>
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
        title="New store"
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
            Create
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
            <p className="text-label text-[var(--c-fg-muted)]">
              You can set the default role and other settings after the
              store is created — open it from the list and switch to the
              Settings tab.
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
              { value: 'team', label: 'Team' },
              { value: 'inventory', label: 'Inventory' },
              { value: 'sales', label: 'Sales' },
              { value: 'settings', label: 'Settings' },
            ]}
            onChange={onSubChange}
            ariaLabel="Store section"
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
        <StoreSalesTab storeId={focus.storeId} />
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
 * the row tap (opens a sheet listing the last 50 movements).
 */
function StoreInventoryTab({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const levelsQuery = trpc.inventory.levels.useQuery({ storeId });
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const utils = trpc.useUtils();

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
    | { kind: 'stocktake'; skuId: string; current: string }
    | { kind: 'wastage'; skuId: string };

  const [action, setAction] = useState<ActionMode | null>(null);
  const [draftTarget, setDraftTarget] = useState('');
  const [draftWasteQty, setDraftWasteQty] = useState('');
  const [draftNote, setDraftNote] = useState('');

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
      toast.success(i18n.t('inventory.toast.stocktakeSaved'));
      setAction(null);
    },
    onError: errToast('common.error'),
  });
  const recordWastage = trpc.inventory.recordWastage.useMutation({
    onSuccess: () => {
      void utils.inventory.levels.invalidate({ storeId });
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

  return (
    <div className="px-4 py-3">
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
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-body font-semibold">{r.name}</span>
                    <span className="font-mono text-body tabular-nums">
                      {formatQty(r.onHand)} {r.unit}
                    </span>
                  </div>
                  {/* M3.17 (2026-05-16): inline pill buttons → Button
                      size="sm" with pearl + danger-ghost variants.
                      Stocktake is a neutral edit; wastage is a real
                      reduce-stock action so the danger-ghost tone is
                      appropriate (red text, no fill — same level as
                      Archive elsewhere). */}
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
          action ? productName({ names: skuById.get(action.skuId)?.names ?? {} }) : ''
        }
        footer={
          !getTg() && action ? (
            <Button
              block
              loading={stocktake.isPending || recordWastage.isPending}
              onClick={() => {
                if (!action) return;
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
                <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 text-label text-[var(--c-fg-muted)]">
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
    </div>
  );
}

/**
 * StoreSalesTab (M2.0c, 2026-05-08).
 *
 * Sales recording surface for a single store. Closes the ERP loop —
 * each sale auto-deducts ingredient inventory via the dish's recipe
 * BOM (server-side, same transaction). Two zones:
 *
 *   - Today's list (top): every sale recorded today, newest first,
 *     showing time + dish + qty + line revenue if priced.
 *   - "Record sale" entry (bottom): dish picker + qty input. Tap
 *     Save → tRPC roundtrip, list refreshes.
 *
 * Permissions:
 *   - `sales.record` (per-store) for the Save action. Granted by
 *     default to manager + staff roles.
 *   - Anyone with read access to the store can see the list.
 */
function StoreSalesTab({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const utils = trpc.useUtils();
  const session = useAuthStore((s) => s.session);
  const canRecord =
    (session?.permissions.includes('sales.record') ?? false) ||
    (session?.permissions.includes('users.manage') ?? false);

  const dishesQuery = trpc.dishes.list.useQuery({ includeArchived: false });
  const salesQuery = trpc.sales.list.useQuery({ storeId });

  const dishById = useMemo(() => {
    const m = new Map<
      string,
      {
        id: string;
        names: Record<string, string>;
        unitPrice: string | null;
        ingredientCount: number;
      }
    >();
    const ingCount = new Map<string, number>();
    for (const ing of dishesQuery.data?.ingredients ?? []) {
      ingCount.set(ing.dishId, (ingCount.get(ing.dishId) ?? 0) + 1);
    }
    for (const d of dishesQuery.data?.dishes ?? []) {
      m.set(d.id, {
        id: d.id,
        names: d.names as Record<string, string>,
        unitPrice: d.unitPrice,
        ingredientCount: ingCount.get(d.id) ?? 0,
      });
    }
    return m;
  }, [dishesQuery.data]);

  const [draftDishId, setDraftDishId] = useState('');
  const [draftQty, setDraftQty] = useState('1');

  const record = trpc.sales.record.useMutation({
    onSuccess: () => {
      void utils.sales.list.invalidate({ storeId });
      // M2.0c: also invalidate inventory levels — consumption rows
      // just landed in the ledger.
      void utils.inventory.levels.invalidate({ storeId });
      toast.success(i18n.t('sales.toast.recorded'));
      setDraftDishId('');
      setDraftQty('1');
    },
    onError: errToast('common.error'),
  });

  const sales = salesQuery.data ?? [];

  // Compute today's headline (revenue + count) for the summary row.
  const summary = useMemo(() => {
    let count = 0;
    let revenue = 0;
    for (const s2 of sales) {
      const qty = Number(s2.qty);
      count += qty;
      if (s2.unitPrice) revenue += qty * Number(s2.unitPrice);
    }
    return { count, revenue };
  }, [sales]);

  // Sort dishes alphabetically for the picker.
  const dishOptions = useMemo(() => {
    const list = [...dishById.values()];
    return list.sort((a, b) =>
      productName({ names: a.names }).localeCompare(productName({ names: b.names })),
    );
  }, [dishById, productName]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {/* Today summary tile. */}
      <div className="grid grid-cols-2 gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
        <div>
          <SectionLabel padded={false}>
            {i18n.t('sales.summary.today')}
          </SectionLabel>
          <div className="font-mono text-h2 font-semibold tabular-nums">
            {formatQty(summary.count.toString())}
          </div>
          <div className="text-label text-[var(--c-fg-muted)]">
            {i18n.t('sales.summary.servings')}
          </div>
        </div>
        <div>
          <SectionLabel padded={false}>
            {i18n.t('sales.summary.revenue')}
          </SectionLabel>
          <div className="font-mono text-h2 font-semibold tabular-nums">
            {formatMoney(summary.revenue)}
          </div>
          <div className="text-label text-[var(--c-fg-muted)]">
            {session?.member.currency ?? 'UZS'}
          </div>
        </div>
      </div>

      {/* Record sale form. */}
      {canRecord ? (
        <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
          {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
          <SectionLabel className="px-0 py-0">
            {i18n.t('sales.form.recordTitle')}
          </SectionLabel>
          {dishOptions.length === 0 ? (
            <p className="text-label text-[var(--c-fg-muted)]">
              {i18n.t('sales.form.noDishesYet')}
            </p>
          ) : (
            <>
              <select
                className="h-10 w-full rounded-[var(--r-pill)] bg-[var(--c-surface)] px-3 text-body ring-hairline"
                value={draftDishId}
                onChange={(e) => setDraftDishId(e.target.value)}
              >
                <option value="">{i18n.t('sales.form.pickDish')}</option>
                {dishOptions.map((d) => {
                  const label = productName({ names: d.names });
                  const suffix =
                    d.ingredientCount === 0
                      ? ` (${i18n.t('sales.form.noRecipe')})`
                      : '';
                  return (
                    <option key={d.id} value={d.id} disabled={d.ingredientCount === 0}>
                      {label}
                      {suffix}
                    </option>
                  );
                })}
              </select>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="1"
                  min="1"
                  value={draftQty}
                  onChange={(e) => setDraftQty(e.target.value)}
                  aria-label={i18n.t('sales.form.qtyLabel')}
                  className="flex-1"
                />
                <Button
                  loading={record.isPending}
                  disabled={!draftDishId || Number(draftQty) <= 0}
                  onClick={() => {
                    if (!draftDishId || Number(draftQty) <= 0) return;
                    record.mutate({
                      storeId,
                      dishId: draftDishId,
                      qty: Number(draftQty).toFixed(2),
                    });
                  }}
                >
                  {i18n.t('sales.form.recordBtn')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* Today's sales list. */}
      <div>
        {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
        <SectionLabel className="mb-2 px-0">
          {i18n.t('sales.list.title')}
        </SectionLabel>
        {salesQuery.isLoading ? (
          <div className="py-4 text-center">
            <Spinner size={16} />
          </div>
        ) : sales.length === 0 ? (
          <EmptyState
            title={i18n.t('sales.empty.title')}
            description={i18n.t('sales.empty.description')}
          />
        ) : (
          <ul className="flex flex-col gap-1" role="list">
            {sales.map((sale) => {
              const dish = dishById.get(sale.dishId);
              const name = dish
                ? productName({ names: dish.names })
                : sale.dishId.slice(0, 8);
              const time = new Date(sale.occurredAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              });
              const lineTotal =
                sale.unitPrice && Number(sale.qty) > 0
                  ? Number(sale.qty) * Number(sale.unitPrice)
                  : null;
              return (
                <li
                  key={sale.id}
                  className="flex items-baseline justify-between gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-label tabular-nums text-[var(--c-fg-muted)]">
                        {time}
                      </span>
                      <span className="truncate text-body font-medium">{name}</span>
                    </div>
                    {lineTotal !== null ? (
                      <div className="text-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × {formatMoney(sale.unitPrice)} ={' '}
                        <span className="font-mono tabular-nums text-[var(--c-fg)]">
                          {formatMoney(lineTotal)}
                        </span>
                      </div>
                    ) : (
                      <div className="text-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × —
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
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
  const storesQuery = trpc.admin.storeList.useQuery();
  const rolesQuery = trpc.admin.roleList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  // M1.9 (2026-05-07): clone-roles is an org-wide write — gate to
  // global admins.
  const sessionStores = session?.stores ?? [];
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

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
    },
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.storeDelete.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.info(i18n.t('admin.toast.storeArchived'));
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
      <div className="flex items-center gap-2 px-4 py-6 text-body-sm text-[var(--c-fg-muted)]">
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

  const canAdmin = adminStoreIds.has(storeId);

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
          <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
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
            <option value="">— no default (operator picks each invite) —</option>
            {storeTierRoles.map((r) => (
              <option key={r.id} value={r.slug}>
                {r.name} (rank {r.rank})
              </option>
            ))}
          </Select>
        )}
        <p className="mt-1 text-label text-[var(--c-fg-muted)]">
          When set, new members invited into this store with no explicit
          role pick are auto-granted this role.
        </p>
      </Field>
      <Switch
        label={i18n.t('admin.label.active')}
        checked={draft.isActive}
        onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
        disabled={!canAdmin}
      />

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
              isActive: draft.isActive,
              defaultRoleSlug: draft.defaultRoleSlug
                ? draft.defaultRoleSlug
                : null,
            });
          }}
        >
          Save
        </Button>
        {/* M1.9: clone-roles requires global admin (was canAdmin + ≥2
            admin stores; per-store managers shouldn't trigger this
            org-wide write). */}
        {isGlobalAdmin && adminStoreIds.size >= 2 ? (
          <Button
            variant="pearl"
            onClick={() => setCloneOpen(true)}
          >
            Clone roles…
          </Button>
        ) : null}
        {canAdmin ? (
          <Button
            variant="danger-ghost"
            onClick={() =>
              nativeConfirm(`Archive "${store.name}"?`, () =>
                remove.mutate({ storeId }),
              )
            }
          >
            Archive
          </Button>
        ) : null}
      </div>
      {!canAdmin ? (
        <Banner tone="info" title="Read-only">
          You don't administer this store. Settings are visible but
          can't be changed from your account.
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
      const parts = [`Cloned ${data.cloned} role binding${data.cloned === 1 ? '' : 's'}`];
      if (data.skippedExisting > 0)
        parts.push(`${data.skippedExisting} already existed`);
      if (data.skippedRank > 0)
        parts.push(`${data.skippedRank} skipped (rank too high)`);
      if (data.assigned > 0)
        parts.push(`${data.assigned} member${data.assigned === 1 ? '' : 's'} assigned`);
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: errToast('common.error'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !cloneMut.isPending && onClose()}
      title="Clone roles into store"
      description={target ? `Target: 🏪 ${target.targetStoreName}` : ''}
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
            Clone
          </Button>
        ) : undefined
      }
    >
      {target ? (
        <div className="flex flex-col gap-3 py-3">
          <Field label={`${i18n.t('admin.field.sourceStore')} *`}>
            {sourceCandidates.length === 0 ? (
              <Banner tone="warn" title="No eligible source">
                You need to administer at least one OTHER store to clone
                from. Ask a higher-rank admin to add you to one first.
              </Banner>
            ) : (
              <Select
                value={sourceStoreId}
                onChange={(e) => setSourceStoreId(e.target.value)}
              >
                <option value="">— pick a source store —</option>
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
              <div className="text-body font-semibold text-[var(--c-fg)]">
                Also assign source members
              </div>
              <p className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                When on, every member with an MSA row in the source
                store also gets one for the target — they'll see and
                operate in both. Off (default) clones only the role
                shape; you staff the target with different people.
              </p>
            </div>
          </label>
          <Banner tone="info" title="What this does">
            For every store-scoped role binding in the source store,
            create the same binding in {target.targetStoreName} (skip
            duplicates). Roles you don't outrank in {target.targetStoreName}
            are skipped — counted separately so you know what to do
            manually.
          </Banner>
        </div>
      ) : null}
    </Sheet>
  );
}

