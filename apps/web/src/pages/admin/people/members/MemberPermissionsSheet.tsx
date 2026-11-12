import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Chip,
  ChipBar,
  EmptyState,
  LoadingState,
  QueryErrorBanner,
  Segmented,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n, useRoleLabels } from '../../../../hooks/useI18n';
import {
  canSetOverride,
  overrideEffects,
  type Actor,
  type TargetMember,
} from '../../../../lib/authority';
import { groupPermissions } from '../permissionGroups';
import { PermissionGroups } from '../PermissionGroups';

/**
 * Per-member permission overrides editor (added 2026-05-05).
 *
 * Three layers shown for each permission key:
 *   1. Role-derived (gray, "from role" badge) — read-only baseline
 *   2. allow override   (green chip) — adds the key on top
 *   3. deny override    (red chip)   — removes the key from baseline
 *
 * UX:
 *   - Each row has a 3-state segmented control: [from role] / [allow] / [deny]
 *     "from role" = no override, fall back to baseline (which itself
 *     may be allow or none — that's fine, the badge tells you what)
 *   - Toggling allow/deny calls memberPermissionSet
 *   - Toggling back to "from role" calls memberPermissionRevoke
 *   - Effective set is shown at top as a small badge count
 */
export function MemberPermissionsSheet({
  actor,
  target,
  onClose,
}: {
  actor: Actor;
  target: {
    memberId: string;
    displayName: string;
    /** The stores this member belongs to (for the per-store
     *  override tabs added 2026-05-06 in A2). Pass an empty
     *  array if the member is org-level. */
    stores: Array<{ id: string; name: string }>;
    member: TargetMember;
  } | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const toast = useToast();
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  const open = !!target;
  const detail = trpc.admin.memberPermissionsList.useQuery(
    { memberId: target?.memberId ?? '' },
    { enabled: open },
  );
  const allPerms = trpc.admin.permissionList.useQuery(undefined, { enabled: open });

  /**
   * Active scope tab: 'global' or one of the member's stores. A scope
   * where the actor may not set overrides (canSetOverride: not their
   * store, or the member outranks them there) is listed but cannot be
   * chosen; the server refuses it too.
   */
  type Scope = { kind: 'global' } | { kind: 'store'; storeId: string; storeName: string };
  const [scope, setScope] = useState<Scope>({ kind: 'global' });
  // Reset scope when sheet opens for a new target. Default to 'global'
  // so the operator lands on the familiar surface.
  // CMP-ADM-1: a scope the server would refuse (the member outranks the
  // actor there, or it is not the actor's store) is read-only.
  const canEditScope = (storeId: string | null) =>
    !!target && canSetOverride(actor, target.member, storeId);
  useEffect(() => {
    if (!target) return;
    const firstStore = target.stores.find((st) => canSetOverride(actor, target.member, st.id));
    setScope(
      canSetOverride(actor, target.member, null) || !firstStore
        ? { kind: 'global' }
        : { kind: 'store', storeId: firstStore.id, storeName: firstStore.name },
    );
  }, [target, actor]);

  const set = trpc.admin.memberPermissionSet.useMutation({
    onSuccess: () => {
      void utils.admin.memberPermissionsList.invalidate({
        memberId: target?.memberId ?? '',
      });
      toast.success(i18n.t('common.saved'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const revoke = trpc.admin.memberPermissionRevoke.useMutation({
    onSuccess: () => {
      void utils.admin.memberPermissionsList.invalidate({
        memberId: target?.memberId ?? '',
      });
      toast.success(i18n.t('common.saved'));
    },
    onError: errToast('common.errors.actionFailed'),
  });

  /**
   * Index overrides by (scopeKey, permissionKey) so each tab can
   * render its own effect chip without cross-talk. The 'global' bucket
   * holds rows where override.scopeType === 'global'; each store
   * bucket holds rows where override.scopeType === 'store' AND
   * scopeId === storeId. (A2, 2026-05-06.)
   */
  const overrideByScopeKey = useMemo(() => {
    const m = new Map<string, Map<string, 'allow' | 'deny'>>();
    for (const o of detail.data?.overrides ?? []) {
      const key = o.scopeType === 'global' ? 'global' : `store:${o.scopeId ?? ''}`;
      const inner = m.get(key) ?? new Map();
      inner.set(o.permissionKey, o.effect);
      m.set(key, inner);
    }
    return m;
  }, [detail.data]);

  const currentScopeKey = scope.kind === 'global' ? 'global' : `store:${scope.storeId}`;
  const overrideByKey = overrideByScopeKey.get(currentScopeKey) ?? new Map();

  // ADM1-05: the tab's own keys. A store no row names is as the
  // organisation (global roles apply in every store).
  const scopeKeys = detail.data
    ? scope.kind === 'global'
      ? detail.data.byScope.global
      : (detail.data.byScope.stores[scope.storeId] ?? detail.data.byScope.global)
    : null;
  const roleKeys = useMemo(() => new Set(scopeKeys?.roleKeys ?? []), [scopeKeys]);

  const grouped = useMemo(
    () => groupPermissions(allPerms.data ?? [], (ns) => roleText.permissionGroup(ns), i18n.locale),
    [allPerms.data, roleText, i18n.locale],
  );
  const scopeStoreId = scope.kind === 'global' ? null : scope.storeId;
  const scopeEditable = canEditScope(scopeStoreId);
  // ADM1-07: what may be set for each key here (lib/authority
  // overrideEffects). A key nothing can be set for, an organisation-wide
  // one in a store, is listed only while an override of it is there to
  // remove.
  const rows = grouped
    .map(
      ([ns, keys]) =>
        [
          ns,
          keys
            .map((p) => ({ key: p.key, p, effects: overrideEffects(actor, p, scopeStoreId) }))
            .filter(({ p, effects }) => effects.allow || effects.deny || overrideByKey.has(p.key)),
        ] as const,
    )
    .filter(([, keys]) => keys.length > 0);
  // Said once above the list: a store manager lacks most keys.
  const allowOnlyOwn =
    scopeEditable &&
    rows.some(([, keys]) =>
      keys.some(({ effects }) => effects.reason === 'people.perm.allowOnlyOwn'),
    );

  const handleSet = (key: string, mode: 'role' | 'allow' | 'deny') => {
    if (!target || !scopeEditable) return;
    const scopeArgs =
      scope.kind === 'global'
        ? { scopeType: 'global' as const }
        : { scopeType: 'store' as const, scopeId: scope.storeId };
    if (mode === 'role') {
      revoke.mutate({
        memberId: target.memberId,
        permissionKey: key,
        ...scopeArgs,
      });
    } else {
      set.mutate({
        memberId: target.memberId,
        permissionKey: key,
        effect: mode,
        ...scopeArgs,
      });
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        target
          ? i18n.t('people.permissionsFor', { name: target.displayName })
          : i18n.t('people.permissionsTitle')
      }
      description={
        scopeKeys
          ? i18n.t('people.effectiveOverridesLine', {
              eff: scopeKeys.effective.length,
              ov: overrideByKey.size,
            })
          : undefined
      }
    >
      {detail.isLoading || allPerms.isLoading ? (
        <LoadingState />
      ) : (detail.isError && !detail.data) || (allPerms.isError && !allPerms.data) ? (
        // Review UI-13 (2026-11-11): a failed load showed a lone "—".
        <QueryErrorBanner query={detail.isError ? detail : allPerms} />
      ) : !detail.data ? (
        <EmptyState compact title={i18n.t('common.noData')} />
      ) : (
        <div className="flex flex-col gap-3 py-3">
          {/* Scope tabs (A2, 2026-05-06): 'Global', then each store the
              member is in; one where the actor may not set overrides is
              shown, disabled. The number counts the overrides set there.
              Review ADM1-13 / ADM1-24 (2026-11-12): the kit's ChipBar (a
              44 px tap area, the kit's disabled look), not a hand-drawn
              26 px pill. */}
          {(target?.stores ?? []).length > 0 && (
            <ChipBar ariaLabel={i18n.t('admin.field.scope')} className="-mx-4 -my-1.5 px-4 py-1.5">
              <Chip
                selected={scope.kind === 'global'}
                disabled={!canEditScope(null)}
                onClick={() => setScope({ kind: 'global' })}
              >
                {i18n.t('people.scopeGlobal')}
                <OverrideCount
                  n={overrideByScopeKey.get('global')?.size ?? 0}
                  selected={scope.kind === 'global'}
                />
              </Chip>
              {(target?.stores ?? []).map((st) => {
                const editable = canEditScope(st.id);
                const isActive = scope.kind === 'store' && scope.storeId === st.id;
                return (
                  <Chip
                    key={st.id}
                    selected={isActive}
                    disabled={!editable}
                    title={editable ? undefined : i18n.t('people.notYourStoreReadOnly')}
                    onClick={() => setScope({ kind: 'store', storeId: st.id, storeName: st.name })}
                  >
                    {st.name}
                    <OverrideCount
                      n={overrideByScopeKey.get(`store:${st.id}`)?.size ?? 0}
                      selected={isActive}
                    />
                  </Chip>
                );
              })}
            </ChipBar>
          )}
          <Banner tone="info" title={i18n.t('people.overridesHowTitle')}>
            {scope.kind === 'global'
              ? i18n.t('people.overridesHowGlobal')
              : i18n.t('people.overridesHowStore', { store: scope.storeName })}
          </Banner>
          {allowOnlyOwn ? (
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('people.perm.allowOnlyOwn')}
            </p>
          ) : null}
          {/* CMP-ADM-2: localised group, name and description, not the
              English seed text and raw keys. */}
          <PermissionGroups
            groups={rows}
            renderRow={({ p, effects }) => {
              const override = overrideByKey.get(p.key) ?? null;
              const fromRole = roleKeys.has(p.key);
              const mode: 'role' | 'allow' | 'deny' = override ?? 'role';
              // The rarer reasons are said on the row itself.
              const rowReason =
                scopeEditable && effects.reason !== 'people.perm.allowOnlyOwn'
                  ? effects.reason
                  : null;
              return (
                <div className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0 text-old-body-sm text-[var(--c-fg)]">
                      {roleText.permission(p.key, p.description)}
                    </div>
                    {fromRole ? (
                      <Badge tone="muted">{i18n.t('people.perm.fromRoleBadge')}</Badge>
                    ) : null}
                  </div>
                  {/* M3.17 (2026-05-16): migrated from local SegBtn to the
                      shared <Segmented> primitive. Per-option activeBg drives
                      the allow=green / deny=red / inherit=action coloring
                      that the old SegBtn baked in via a `tone` prop. */}
                  <Segmented<'role' | 'allow' | 'deny'>
                    size="sm"
                    value={mode}
                    options={[
                      { value: 'role', label: i18n.t('people.perm.fromRole') },
                      {
                        value: 'allow',
                        label: i18n.t('people.perm.allow'),
                        activeBg: 'bg-[var(--c-success)]',
                        disabled: !effects.allow,
                      },
                      {
                        value: 'deny',
                        label: i18n.t('people.perm.deny'),
                        activeBg: 'bg-[var(--c-danger)]',
                        disabled: !effects.deny,
                      },
                    ]}
                    onChange={(next) => handleSet(p.key, next)}
                    disabled={!scopeEditable || set.isPending || revoke.isPending}
                    // Each choice is saved at once: arrows only move.
                    followFocus={false}
                    ariaLabel={roleText.permission(p.key, p.description)}
                  />
                  {rowReason ? (
                    <p className="text-old-label text-[var(--c-fg-muted)]">{i18n.t(rowReason)}</p>
                  ) : null}
                </div>
              );
            }}
          />
        </div>
      )}
    </Sheet>
  );
}

/** The number of overrides set in a scope, on its tab; nothing for none. */
function OverrideCount({ n, selected }: { n: number; selected: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={
        'ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-old-tiny ' +
        // V7: inverted on the selected chip; white-on-white-tint went
        // unreadable once the dark theme's action fill turned light.
        (selected
          ? 'bg-[var(--c-action-fg)] text-[var(--c-action)]'
          : 'bg-[var(--c-action)] text-[var(--c-action-fg)]')
      }
    >
      {n}
    </span>
  );
}
