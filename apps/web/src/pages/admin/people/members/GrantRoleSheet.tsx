import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  FieldGroup,
  LoadingState,
  QueryErrorBanner,
  Segmented,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n, useRoleLabels } from '../../../../hooks/useI18n';
import { useAdminStoreIds, useIsOrgAdmin } from '../../../../hooks/useAdminAuthority';
import {
  canGrantRole,
  canGrantTo,
  orgRankOf,
  rankIn,
  rolePassesOn,
  type Actor,
  type TargetMember,
} from '../../../../lib/authority';
import { StoreCheckList } from '../StoreCheckList';

/**
 * GrantRoleSheet — two-step picker.
 *
 *   Step 1: pick scope.
 *     - "Globally"     → only org-tier roles (rank ≥ 80). Hidden if the
 *                        actor is a store-scoped admin only (their
 *                        adminStoreIds doesn't cover the whole org).
 *     - "In specific store(s)" → store-tier roles (rank < 80). The
 *                        store dropdown is filtered to session.adminStoreIds
 *                        — a store-scoped admin only sees their own stores.
 *
 *   Step 2: pick role.
 *     - Filtered to roles whose rank < the actor's effective rank IN
 *       the chosen scope. For "store" scope with multiple stores
 *       selected, we use the MIN rank across the selected stores
 *       (because each store-binding is independently gated server-side
 *       — if any one fails, the operation aborts mid-way).
 *
 *   When a role is tapped:
 *     - Global → 1 grantRole call
 *     - Store(s) → N grantRole calls in sequence (one per selected
 *                  store). Server's idempotency check makes re-runs safe.
 *
 * Defaults: if the caller passes `defaultStoreId` (PeopleSection does
 * this when StoreSwitcher is in 'specific' mode), we pre-select store
 * scope + that store so the operator doesn't have to re-pick.
 */
export function GrantRoleSheet({
  actor,
  target,
  onClose,
}: {
  actor: Actor;
  target: {
    userId: string;
    displayName: string;
    defaultStoreId?: string | null;
    member: Pick<TargetMember, 'userId' | 'bindings'>;
  } | null;
  onClose: () => void;
}) {
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useAdminStoreIds();
  const sessionStores = useMemo(() => session?.stores ?? [], [session?.stores]);
  const i18n = useI18n();
  const roleText = useRoleLabels();

  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: !!target });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const grant = trpc.admin.grantRole.useMutation({
    onError: errToast('common.errors.actionFailed'),
  });

  // Two-step state.
  const [scopeMode, setScopeMode] = useState<'global' | 'store'>('store');
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(new Set());

  // Reset state when the target changes (sheet opens for a new member).
  useEffect(() => {
    if (!target) return;
    if (target.defaultStoreId && adminStoreIds.has(target.defaultStoreId)) {
      setScopeMode('store');
      setSelectedStoreIds(new Set([target.defaultStoreId]));
    } else {
      setScopeMode('store');
      setSelectedStoreIds(new Set());
    }
  }, [target, adminStoreIds]);

  // C2: stores the actor can administer, intersected with the org's
  // store list (so we always render fresh names). ADM1-08: only those
  // where the actor outranks the member.
  const eligibleStores = useMemo(
    () =>
      sessionStores.filter(
        (s) =>
          adminStoreIds.has(s.id) &&
          !!target &&
          canGrantTo(actor, target.member, { type: 'store', storeId: s.id }),
      ),
    [sessionStores, adminStoreIds, actor, target],
  );

  // Whether the actor can grant a 'global' (org-tier) binding.
  // 2026-10-21 audit CA-16 (A-10): the server requires org.admin for a
  // global binding; the old "admin of every visible store" test was true
  // for a single-store manager.
  const canGrantGlobal = useIsOrgAdmin();

  // Effective rank in the chosen scope: the lowest over the selected
  // stores, because the grant fans out to one server call per store and
  // each is gated on its own store rank — the weakest link wins.
  // CMP-ADM-1: rank in a store counts global bindings and that store's,
  // as the server does; the old max(myMaxRank, storeRanks[id]) let a
  // manager of A look like a manager of B.
  const effectiveRank = useMemo(() => {
    if (scopeMode === 'global') return orgRankOf(actor.bindings);
    if (selectedStoreIds.size === 0) return 0;
    return Math.min(...[...selectedStoreIds].map((id) => rankIn(actor.bindings, id)));
  }, [scopeMode, selectedStoreIds, actor]);

  /**
   * Roles the server would grant in every chosen scope (lib/authority
   * canGrantRole: org-tier roles only globally, store roles only in the
   * actor's stores, always below the actor's rank there). The chosen
   * stores already take the member (eligibleStores); globally, the actor
   * must outrank them organisation-wide (canGrantTo).
   */
  const grantableRoles = useMemo(() => {
    const globalTakes = !!target && canGrantTo(actor, target.member, { type: 'global' });
    return [...(rolesQuery.data ?? [])]
      .filter((r) =>
        scopeMode === 'global'
          ? globalTakes && canGrantRole(actor, r, { type: 'global' })
          : [...selectedStoreIds].every((storeId) =>
              canGrantRole(actor, r, { type: 'store', storeId }),
            ),
      )
      .map((r) => ({
        ...r,
        // DX-ADM-1: a custom role with a key the actor lacks in a chosen
        // scope stays listed, greyed, with the reason (D8).
        keysMissing:
          scopeMode === 'global'
            ? !rolePassesOn(r, { type: 'global' })
            : [...selectedStoreIds].some((storeId) => !rolePassesOn(r, { type: 'store', storeId })),
      }))
      .sort((a, b) => Number(a.keysMissing) - Number(b.keysMissing) || b.rank - a.rank);
  }, [rolesQuery.data, actor, target, scopeMode, selectedStoreIds]);

  // DX-IX-10: the scope and stores picked so far are the sheet's input;
  // closing by Esc / backdrop / Back asks before dropping them.
  const initialStoreId =
    target?.defaultStoreId && adminStoreIds.has(target.defaultStoreId)
      ? target.defaultStoreId
      : null;
  const grantChanged =
    !!target &&
    (scopeMode !== 'store' ||
      selectedStoreIds.size !== (initialStoreId ? 1 : 0) ||
      (initialStoreId !== null && !selectedStoreIds.has(initialStoreId)));

  const toggleStore = (id: string) => {
    setSelectedStoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePick = async (slug: string) => {
    if (!target) return;
    if (scopeMode === 'global') {
      try {
        const data = await grant.mutateAsync({
          userId: target.userId,
          roleSlug: slug,
          scopeType: 'global',
        });
        toast[data.granted ? 'success' : 'info'](
          i18n.t(data.granted ? 'people.toastRoleGranted' : 'people.toastRoleAlready'),
        );
        void utils.admin.memberList.invalidate();
        onClose();
      } catch {
        /* error toast already shown */
      }
      return;
    }
    // Store fan-out. We loop sequentially so a mid-run server error
    // (rank changed, store archived, etc.) leaves the partial result
    // visible to the user and they can retry the rest.
    let createdCount = 0;
    let skipped = 0;
    for (const storeId of selectedStoreIds) {
      try {
        const data = await grant.mutateAsync({
          userId: target.userId,
          roleSlug: slug,
          scopeType: 'store',
          scopeId: storeId,
        });
        if (data.granted) createdCount++;
        else skipped++;
      } catch {
        // first failure: stop here; toast already raised by onError
        void utils.admin.memberList.invalidate();
        return;
      }
    }
    if (createdCount > 0) {
      toast.success(
        i18n.t('people.toastGrantedInStores', { n: createdCount }) +
          (skipped > 0 ? ` ${i18n.t('people.toastAlreadyHad', { n: skipped })}` : ''),
      );
    } else if (skipped > 0) {
      toast.info(i18n.t('people.toastAlreadyEverywhere'));
    }
    void utils.admin.memberList.invalidate();
    onClose();
  };

  const canSubmit = scopeMode === 'global' ? canGrantGlobal : selectedStoreIds.size > 0;

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      hasChanges={grantChanged && !grant.isPending}
      title={i18n.t('people.grantRoleTitle')}
      description={target ? i18n.t('people.grantRoleTo', { name: target.displayName }) : ''}
    >
      <div className="flex flex-col gap-3 py-3">
        {/* Step 1 — scope */}
        {/* M3.17 (2026-05-16): SegBtn → Segmented. Review UI-07
            (2026-11-11): "Globally" is disabled when the actor is not an
            org admin, and the hint below says why. It used to be a
            choosable option that did nothing, labelled "(workspace admins
            only)". */}
        <FieldGroup label={i18n.t('admin.field.scope')}>
          <Segmented<'store' | 'global'>
            value={scopeMode}
            options={[
              { value: 'store', label: i18n.t('people.grantInStores') },
              {
                value: 'global',
                label: i18n.t('people.grantGlobally'),
                disabled: !canGrantGlobal,
              },
            ]}
            onChange={setScopeMode}
            ariaLabel={i18n.t('admin.field.scope')}
          />
          {!canGrantGlobal ? (
            <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('people.globalGrantLockedHint')}
            </p>
          ) : null}
        </FieldGroup>

        {/* Store multi-select (visible in store mode) */}
        {scopeMode === 'store' ? (
          <FieldGroup label={i18n.t('admin.field.stores')}>
            {eligibleStores.length === 0 ? (
              <Banner tone="warn" title={i18n.t('people.noGrantStoresTitle')}>
                {i18n.t('people.noGrantStoresBody')}
              </Banner>
            ) : (
              <StoreCheckList
                stores={eligibleStores}
                isChecked={(st) => selectedStoreIds.has(st.id)}
                onChange={(st) => toggleStore(st.id)}
              />
            )}
          </FieldGroup>
        ) : null}

        {/* Step 2 — role list (filtered by chosen scope + effectiveRank) */}
        {!canSubmit ? (
          <p className="text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('people.pickScopeFirst')}
          </p>
        ) : rolesQuery.isLoading ? (
          <LoadingState variant="inline" label={i18n.t('admin.label.loadingRoles')} />
        ) : rolesQuery.isError && !rolesQuery.data ? (
          // Review ADM1-22 (2026-11-12): a failed load read "no role you
          // can grant here".
          <QueryErrorBanner query={rolesQuery} />
        ) : grantableRoles.length === 0 ? (
          <Banner tone="warn" title={i18n.t('people.noGrantableTitle')}>
            {scopeMode === 'global'
              ? i18n.t('people.noGrantableGlobal', { rank: effectiveRank })
              : i18n.t('people.noGrantableStore', { rank: effectiveRank })}
          </Banner>
        ) : (
          grantableRoles.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={grant.isPending || r.keysMissing}
              onClick={() => handlePick(r.slug)}
              className="press flex items-center justify-between rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2.5 text-left ring-hairline disabled:opacity-50"
            >
              <div>
                <div className="text-old-body font-semibold text-[var(--c-fg)]">
                  {roleText.name(r)}
                </div>
                <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                  {r.keysMissing
                    ? i18n.t('people.roleHasKeysYouLack')
                    : i18n.t('people.rankLine', { rank: r.rank }) +
                      (roleText.description(r) ? ` · ${roleText.description(r)}` : '')}
                </div>
              </div>
              {r.isBuiltIn ? <Badge tone="muted">{i18n.t('admin.label.builtIn')}</Badge> : null}
            </button>
          ))
        )}
      </div>
    </Sheet>
  );
}
