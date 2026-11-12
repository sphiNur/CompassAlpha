import { useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  FieldGroup,
  Input,
  LoadingState,
  QueryErrorBanner,
  Select,
  Sheet,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts/schemas/roles';
import { TG_USER_ID_MESSAGE } from '@compass/contracts/limits';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { useI18n, useRoleLabels } from '../../../../hooks/useI18n';
import { tgIdProblem } from '../../../../lib/adminFields';
import { canGrantRole, rolePassesOn, type Actor } from '../../../../lib/authority';
import { type InviteDraft, StoreName } from '../shared';

export function ManualInviteSheet({
  mode = 'tgid',
  actor,
  draft,
  setDraft,
  onSubmit,
  pending,
}: {
  mode?: 'tgid' | 'link';
  actor: Actor;
  draft: InviteDraft | null;
  setDraft: (d: InviteDraft | null) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  const isLink = mode === 'link';
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: !!draft });
  const storesQuery = trpc.admin.storeList.useQuery(undefined, { enabled: !!draft });
  // C2 (2026-05-06): a store-scoped admin can only invite into the
  // stores they administer. We filter the role list AND the store
  // multi-select against `session.adminStoreIds`. Org-tier roles
  // (admin / super_admin) get hidden when the actor isn't a global
  // admin — a store-scoped manager has no business creating org-tier
  // members; the server gate would reject anyway.
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  // 2026-10-21 audit CA-16 (A-10): explicit org.admin marker, not the
  // "admin of every visible store" heuristic.
  const isGlobalAdmin = session?.permissions.includes('org.admin') ?? false;

  const eligibleStores = useMemo(
    () => (storesQuery.data ?? []).filter((st) => adminStoreIds.has(st.id)),
    [storesQuery.data, adminStoreIds],
  );
  // ADM1-07: the server weighs the role against the actor's rank in each
  // store the invite names (org-tier roles: organisation-wide, org admins
  // only), not against their highest rank anywhere. With no store picked
  // yet, a role passes when some store of theirs would take it.
  const pickedStoreIds = draft?.storeIds;
  const rankAllows = (r: { rank: number }) => {
    if (r.rank >= ADMIN_RANK) return canGrantRole(actor, r, { type: 'global' });
    const ids = pickedStoreIds?.length ? pickedStoreIds : null;
    return ids
      ? ids.every((storeId) => canGrantRole(actor, r, { type: 'store', storeId }))
      : eligibleStores.some((st) => canGrantRole(actor, r, { type: 'store', storeId: st.id }));
  };
  const sortedRoles = [...(rolesQuery.data ?? [])]
    // Org-tier roles only for org admins (cannotInviteOrgAdminAsStoreAdmin).
    .filter((r) => isGlobalAdmin || r.rank < ADMIN_RANK)
    // The picked role stays listed so the reason below can name it.
    .filter((r) => rankAllows(r) || r.slug === draft?.roleSlug)
    // DX-ADM-22: highest first, like the grant sheet (was by stored name).
    .sort((a, b) => b.rank - a.rank);
  // DX-ADM-1: a custom role carrying a key the actor lacks where it would
  // be bound (org-tier roles globally, others in each chosen store; with
  // no store chosen yet, in any of theirs) is shown greyed with the reason.
  const keysMissing = (r: (typeof sortedRoles)[number]) => {
    if (r.rank >= ADMIN_RANK) return !rolePassesOn(r, { type: 'global' });
    const ids = pickedStoreIds?.length ? pickedStoreIds : null;
    return ids
      ? ids.some((storeId) => !rolePassesOn(r, { type: 'store', storeId }))
      : !eligibleStores.some((st) => rolePassesOn(r, { type: 'store', storeId: st.id }));
  };
  const pickedRole = sortedRoles.find((r) => r.slug === draft?.roleSlug) ?? null;
  const pickedRoleOutranks = pickedRole ? !rankAllows(pickedRole) : false;
  const pickedRoleBlocked = pickedRole ? keysMissing(pickedRole) || pickedRoleOutranks : false;

  // DX-ADM-5: the id is kept as typed; a phone number is refused with a
  // reason instead of being turned into digits.
  const tgProblem = draft ? tgIdProblem(draft.tgUserId) : null;
  const [tgTouched, setTgTouched] = useState(false);
  const open = !!draft;
  useEffect(() => {
    if (!open) setTgTouched(false);
  }, [open]);
  const tgShown = tgProblem === 'notDigits' || (tgTouched && tgProblem === 'length');
  const tgIdValid = draft ? draft.tgUserId.trim() !== '' && tgProblem === null : false;
  // Org-tier roles bypass the store check at the server side, so we
  // shouldn't force the admin to pick a store for them. Review ADM1-19:
  // by rank, as the server decides (a custom role can be org-tier too).
  const isOrgTierRole = (pickedRole?.rank ?? 0) >= ADMIN_RANK;
  const requiresStore = !isOrgTierRole;
  const hasStore = (draft?.storeIds.length ?? 0) > 0;
  const canSubmit = (isLink || tgIdValid) && (!requiresStore || hasStore) && !pickedRoleBlocked;
  // DX-ADM-28: typed id / name or a picked role is input worth asking about.
  const inviteChanged =
    !!draft && (draft.tgUserId !== '' || draft.displayName !== '' || draft.roleSlug !== '');
  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && !pending && setDraft(null)}
      hasChanges={inviteChanged}
      title={i18n.t(isLink ? 'admin.invite.link.title' : 'admin.invite.byTgId.title')}
      description={i18n.t(
        isLink ? 'admin.invite.link.description' : 'admin.invite.byTgId.description',
      )}
      footer={
        <Button block size="lg" loading={pending} disabled={!canSubmit} onClick={onSubmit}>
          {i18n.t(isLink ? 'admin.invite.link.submit' : 'admin.invite.byTgId.submit')}
        </Button>
      }
    >
      {draft ? (
        <div className="flex flex-col gap-3 py-3">
          {isLink ? (
            <p className="text-old-body-sm text-[var(--c-fg-muted)]">
              {i18n.t('admin.invite.link.hint')}
            </p>
          ) : (
            <>
              <Field
                label={i18n.t('admin.field.tgUserId')}
                required
                hint={tgShown ? null : i18n.t('admin.invite.tgIdHint')}
                error={tgShown ? i18n.t(TG_USER_ID_MESSAGE) : null}
              >
                <Input
                  value={draft.tgUserId}
                  onChange={(e) => setDraft({ ...draft, tgUserId: e.target.value })}
                  onBlur={() => setTgTouched(true)}
                  inputMode="numeric"
                  maxLength={32}
                  placeholder={i18n.t('admin.field.tgUserIdPlaceholder')}
                  autoFocus
                />
              </Field>
              <Field label={i18n.t('admin.field.displayName')}>
                <Input
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  maxLength={200}
                  placeholder={i18n.t('admin.field.displayNamePlaceholder')}
                />
              </Field>
            </>
          )}
          <Field
            label={i18n.t('admin.field.role')}
            error={
              pickedRoleOutranks
                ? i18n.t('auth.errors.cannotGrantEqualOrHigher')
                : pickedRoleBlocked
                  ? i18n.t('people.roleHasKeysYouLack')
                  : null
            }
          >
            {rolesQuery.isLoading ? (
              <LoadingState variant="inline" label={i18n.t('admin.label.loadingRoles')} />
            ) : rolesQuery.isError && !rolesQuery.data ? (
              // Review ADM1-22 (2026-11-12): a failed load left only "no
              // role yet" to pick.
              <QueryErrorBanner query={rolesQuery} />
            ) : (
              <Select
                value={draft.roleSlug}
                onChange={(e) => setDraft({ ...draft, roleSlug: e.target.value })}
              >
                <option value="">{i18n.t('admin.invite.noRoleYet')}</option>
                {sortedRoles.map((r) => {
                  const blocked = keysMissing(r) && r.slug !== draft.roleSlug;
                  return (
                    <option key={r.id} value={r.slug} disabled={blocked}>
                      {blocked
                        ? i18n.t('people.roleNameKeysYouLack', { name: roleText.name(r) })
                        : roleText.name(r)}
                    </option>
                  );
                })}
              </Select>
            )}
          </Field>
          {requiresStore ? (
            <FieldGroup
              label={
                hasStore
                  ? i18n.t('admin.field.storesSelected', { n: draft.storeIds.length })
                  : i18n.t('admin.field.storesPickAtLeastOne')
              }
            >
              {storesQuery.isLoading ? (
                <LoadingState variant="inline" label={i18n.t('admin.label.loadingStores')} />
              ) : storesQuery.isError && !storesQuery.data ? (
                // ADM2-22 (2026-11-11): a failed load read "no stores to
                // invite into".
                <QueryErrorBanner query={storesQuery} />
              ) : eligibleStores.length === 0 ? (
                <Banner tone="warn" title={i18n.t('admin.banner.noStoresToInviteInto.title')}>
                  {i18n.t('admin.banner.noStoresToInviteInto.body')}
                </Banner>
              ) : (
                <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                  {eligibleStores.map((st) => {
                    const checked = draft.storeIds.includes(st.id);
                    return (
                      <Checkbox
                        key={st.id}
                        className="px-2"
                        checked={checked}
                        label={<StoreName store={st} />}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            storeIds: e.target.checked
                              ? [...draft.storeIds, st.id]
                              : draft.storeIds.filter((id) => id !== st.id),
                          })
                        }
                      />
                    );
                  })}
                </div>
              )}
              <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('admin.invite.staffNeedStoreHint')}
                {!isGlobalAdmin ? ' ' + i18n.t('admin.invite.onlyYourStoresHint') : ''}
              </p>
            </FieldGroup>
          ) : (
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('admin.invite.adminBypassHint')}
            </p>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
