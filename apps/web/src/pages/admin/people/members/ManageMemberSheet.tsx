import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  FieldGroup,
  Input,
  LoadingState,
  QueryErrorBanner,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n } from '../../../../hooks/useI18n';
import { useAdminStoreIds, useIsOrgAdmin } from '../../../../hooks/useAdminAuthority';
import { nativeConfirm } from '../../shared';
import {
  canDetachFromStore,
  canRename,
  transferTargets,
  type Actor,
  type TargetMember,
} from '../../../../lib/authority';
import { TransferStoreSheet } from './TransferStoreSheet';
import { StoreName } from '../shared';

/**
 * Per-member admin panel: rename + per-store assignment.
 * - Rename bypasses the user's `displayNameLocked` flag (admin override).
 * - Store assignments are toggle-checkboxes against `admin.storeList`,
 *   with a live mutation per click. The query auto-invalidates so the
 *   UI updates without a full refresh.
 */
export function ManageMemberSheet({
  actor,
  target,
  onClose,
}: {
  actor: Actor;
  target: {
    memberId: string;
    userId: string;
    displayName: string;
    member: TargetMember;
  } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const open = !!target;
  const storesQuery = trpc.admin.storeList.useQuery(undefined, { enabled: open });
  const assignmentsQuery = trpc.admin.memberStoreAssignments.useQuery(
    target ? { memberId: target.memberId } : { memberId: '00000000-0000-0000-0000-000000000000' },
    { enabled: open && !!target },
  );
  // C2 (2026-05-06): a store-scoped admin can only assign/unassign in
  // the stores they administer. Stores outside `adminStoreIds` are
  // shown as read-only rows so the operator can see WHO the member
  // already belongs to (even cross-store), but can only mutate the
  // stores they actually run.
  const adminStoreIds = useAdminStoreIds();
  // M1.9: gate cross-store moves behind global-admin only. For per-
  // store managers (who post-B1 have users.manage), the unassign +
  // reassign workflow on the checkbox grid is enough; the dedicated
  // Transfer wizard is an org-wide-write surface they shouldn't reach.
  // 2026-10-21 audit CA-16 (A-10): explicit org.admin marker.
  const isGlobalAdmin = useIsOrgAdmin();
  const [name, setName] = useState(target?.displayName ?? '');
  // Refresh local name field when target changes.
  useEffect(() => {
    if (target) setName(target.displayName);
  }, [target]);

  const renameMut = trpc.admin.memberSetDisplayName.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.success(i18n.t('admin.toast.memberUpdated'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const assignMut = trpc.admin.memberAssignStore.useMutation({
    onSuccess: () => {
      void utils.admin.memberStoreAssignments.invalidate();
    },
    onError: errToast('common.errors.actionFailed'),
  });
  // ADM-8 (2026-10-30, owner decision): unticking a store takes the person
  // out of it — assignment, the store's roles and its permission
  // overrides — as "remove from store" does. Removing only the assignment
  // left the roles, and with them access to the store.
  const detachMut = trpc.admin.memberDetachFromStore.useMutation({
    onSuccess: () => {
      void utils.admin.memberStoreAssignments.invalidate();
      void utils.admin.memberList.invalidate();
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const assignedIds = useMemo(
    () => new Set((assignmentsQuery.data ?? []).map((r) => r.storeId)),
    [assignmentsQuery.data],
  );
  // 2026-10-21 audit CA-07: renaming changes the person's global name,
  // so the server requires org.admin or authority over every store the
  // member is in, and a higher rank (lib/authority canRename, ADM1-06:
  // ranks, store roles and other organisations count; oneself always).
  const renameAllowed = target ? canRename(actor, target.member) : false;

  // D2 (2026-05-06): transfer wizard state. fromStoreId is set when
  // the operator taps "Transfer..." on a particular row. The sheet
  // mounts as a modal-on-modal which is fine on Telegram WebApp
  // because Sheets stack.
  const [transferFrom, setTransferFrom] = useState<{
    storeId: string;
    storeName: string;
  } | null>(null);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={target?.displayName ?? i18n.t('people.memberFallback')}
      description={i18n.t('people.editMemberHint')}
    >
      {target ? (
        <div className="flex flex-col gap-4 py-3">
          <Field
            label={i18n.t('admin.field.displayNameOverride')}
            hint={i18n.t('people.nameOverrideHint')}
          >
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                disabled={!renameAllowed}
                placeholder={i18n.t('admin.field.memberNamePlaceholder')}
              />
              {/* md, not sm (RE-ADM-9): the field beside it is 44px, and at
                  sm a 32px button truncated "Save" at 360px. shrink-0 keeps
                  the label whole; the field takes what is left. */}
              <Button
                className="shrink-0"
                loading={renameMut.isPending}
                disabled={!renameAllowed || !name.trim() || name.trim() === target.displayName}
                onClick={() =>
                  renameMut.mutate({ memberId: target.memberId, displayName: name.trim() })
                }
              >
                {i18n.t('common.save')}
              </Button>
            </div>
          </Field>

          <FieldGroup label={i18n.t('admin.field.assignedStores')}>
            {storesQuery.isLoading || assignmentsQuery.isLoading ? (
              <LoadingState variant="inline" />
            ) : storesQuery.isError && !storesQuery.data ? (
              // Review ADM1-22 (2026-11-12): a failed load read "no stores
              // in the workspace".
              <QueryErrorBanner query={storesQuery} />
            ) : assignmentsQuery.isError && !assignmentsQuery.data ? (
              <QueryErrorBanner query={assignmentsQuery} />
            ) : (
              <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                {(storesQuery.data ?? []).map((st) => {
                  const checked = assignedIds.has(st.id);
                  const pending = assignMut.isPending || detachMut.isPending;
                  // C2: stores you don't administer are visible (so
                  // you see the full picture) but the checkbox is
                  // disabled. The server would reject anyway. ADM1-07:
                  // so is taking someone who outranks you there out.
                  const editable = checked
                    ? canDetachFromStore(actor, target.member, st.id)
                    : adminStoreIds.has(st.id);
                  // UI-01: the kit checkbox names its store itself, and the
                  // transfer button sits beside it, not inside its <label>
                  // (a click there had to be kept from ticking the box).
                  return (
                    <div
                      key={st.id}
                      className="flex items-center gap-2 px-2"
                      title={adminStoreIds.has(st.id) ? undefined : i18n.t('people.notYourStore')}
                    >
                      <Checkbox
                        className="min-w-0 flex-1"
                        checked={checked}
                        disabled={pending || !editable}
                        label={<StoreName store={st} />}
                        onChange={(e) => {
                          if (e.target.checked) {
                            assignMut.mutate({
                              memberId: target.memberId,
                              storeId: st.id,
                            });
                          } else {
                            nativeConfirm(
                              i18n.t('admin.confirm.removeFromStore', {
                                name: target.displayName,
                                store: st.name,
                              }),
                              () =>
                                detachMut.mutate({
                                  memberId: target.memberId,
                                  storeId: st.id,
                                }),
                            );
                          }
                        }}
                      />
                      {/* D2 (2026-05-06): "Transfer..." per assigned
                          row. M1.9 (2026-05-07): gated to global admins
                          only — store-scoped managers should use the
                          unassign+reassign workflow on this same grid. */}
                      {checked &&
                      editable &&
                      isGlobalAdmin &&
                      transferTargets(actor, target.member, st.id, storesQuery.data ?? []).length >
                        0 ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="shrink-0"
                          title={i18n.t('people.transferTooltip')}
                          onClick={() => setTransferFrom({ storeId: st.id, storeName: st.name })}
                        >
                          {i18n.t('admin.action.transfer')}
                        </Button>
                      ) : !editable ? (
                        <span className="shrink-0 text-old-label text-[var(--c-fg-muted)]">
                          {i18n.t('people.readOnlyStore')}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
                {(storesQuery.data ?? []).length === 0 ? (
                  <span className="px-2 py-1 text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('people.noStoresInOrg')}
                  </span>
                ) : null}
              </div>
            )}
            <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('people.storeScopeHint')}
            </p>
          </FieldGroup>
        </div>
      ) : null}
      {target && transferFrom ? (
        <TransferStoreSheet
          actor={actor}
          target={{
            memberId: target.memberId,
            displayName: target.displayName,
            fromStoreId: transferFrom.storeId,
            fromStoreName: transferFrom.storeName,
            member: target.member,
          }}
          onClose={() => setTransferFrom(null)}
        />
      ) : null}
    </Sheet>
  );
}
