import {
  Button,
  ListRow,
  QueryErrorBanner,
  SectionLabel,
  useToast,
  rowGroupClass,
  useConfirm,
} from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { formatList } from '../../../../lib/listFormat';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useDateFormat, useI18n, useRoleLabels } from '../../../../hooks/useI18n';

/**
 * 2026-10-21 CA-19: pending invite links (not accepted / revoked /
 * expired) the viewer may manage, each with a Revoke action. Server
 * scopes the list: org admins see all, store admins only invites into
 * their own stores. Renders nothing while empty to keep the hub compact.
 */
export function PendingInvitesList({ enabled }: { enabled: boolean }) {
  const i18n = useI18n();
  const confirm = useConfirm();
  const roleText = useRoleLabels();
  const dateFmt = useDateFormat();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const invitesQuery = trpc.admin.memberInviteList.useQuery(undefined, {
    enabled,
    retry: false,
  });
  const revoke = trpc.admin.memberInviteRevoke.useMutation({
    onSuccess: () => {
      void utils.admin.memberInviteList.invalidate();
      toast.info(i18n.t('admin.toast.inviteRevoked'));
    },
    onError: (err) => {
      void utils.admin.memberInviteList.invalidate();
      errToast('common.errors.actionFailed')(err);
    },
  });
  const invites = invitesQuery.data ?? [];
  // Review ADM1-22 (2026-11-12): a failed load showed nothing, as if there
  // were no pending invites.
  if (invitesQuery.isError && !invitesQuery.data) {
    return (
      <div className="mt-3">
        <QueryErrorBanner query={invitesQuery} />
      </div>
    );
  }
  if (invites.length === 0) return null;

  return (
    <div className="mt-3">
      <SectionLabel as="h3" padded={false} className="mb-2">
        {i18n.t('people.pendingInvitesCount', { n: invites.length })}
      </SectionLabel>
      <div className={rowGroupClass}>
        {invites.map((inv) => {
          // COREWEB1-19: listed the way the language lists.
          const roles = formatList(
            inv.roles.map((r) => roleText.name(r)),
            i18n.locale,
          );
          const stores = formatList(
            inv.stores.map((st) => st.name),
            i18n.locale,
          );
          const expires = dateFmt.date(inv.expiresAt);
          return (
            <ListRow
              key={inv.id}
              className="rounded-[var(--r-card)]"
              // ADM-15 (2026-10-30): a deleted role read as "default role".
              label={
                inv.roleDeleted
                  ? [roles, i18n.t('people.pendingInviteRoleDeleted')].filter(Boolean).join(' · ')
                  : roles || i18n.t('people.pendingInviteDefaultRole')
              }
              hint={[
                stores || i18n.t('people.pendingInviteOrgWide'),
                inv.invitedBy?.displayName
                  ? i18n.t('people.pendingInviteMeta', {
                      name: inv.invitedBy.displayName,
                      date: expires,
                    })
                  : i18n.t('people.pendingInviteExpires', { date: expires }),
              ].join(' · ')}
              trailing={
                <Button
                  size="sm"
                  variant="danger"
                  disabled={revoke.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: i18n.t('people.confirmRevokeInvite'),
                      confirmLabel: i18n.t('people.revokeInvite'),
                      danger: true,
                    });
                    if (ok) revoke.mutate({ inviteId: inv.id });
                  }}
                >
                  {i18n.t('people.revokeInvite')}
                </Button>
              }
            />
          );
        })}
      </div>
    </div>
  );
}
