/**
 * The whole invite: the hub (link or Telegram id), the form, sending the
 * link and the copy-by-hand fallback. D6 (2026-11-13): out of
 * PeopleSection so the Admin home can open it for a manager of one store
 * without the Stores › store › Team detour.
 */
import { useState } from 'react';
import { useToast } from '@compass/ui';
import { STALE } from '../../../../config/timings';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { copyText } from '../../../../lib/clipboard';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n } from '../../../../hooks/useI18n';
import { getTg } from '../../../../lib/telegram';
import {
  inviteLink as makeInviteLink,
  shareLink as makeShareLink,
} from '../../../../lib/telegramLinks';
import { useStoreClocking } from '../../../attendance/useStoreClocking';
import { InviteCopySheet } from '../InviteCopySheet';
import { type InviteDraft, useActor } from '../shared';
import { InviteHubSheet } from './InviteHubSheet';
import { ManualInviteSheet } from './ManualInviteSheet';

export function InviteFlow({
  open,
  onClose,
  storeIds,
  preferOrgTier = false,
}: {
  open: boolean;
  onClose: () => void;
  /** The stores the form starts with. */
  storeIds: string[];
  /** The organisation-level list: an org-tier role is the default. */
  preferOrgTier?: boolean;
}) {
  const session = useAuthStore((s) => s.session);
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const [manualDraft, setManualDraft] = useState<InviteDraft | null>(null);
  const [linkDraft, setLinkDraft] = useState<InviteDraft | null>(null);
  const [linkAction, setLinkAction] = useState<'share' | 'copy'>('share');
  // The inviter's own roles, for the rank rules (useActor).
  const membersQuery = trpc.admin.memberList.useQuery(undefined, {
    enabled: open || !!manualDraft || !!linkDraft,
  });
  const actor = useActor(membersQuery.data);
  // A3: the form's "Clocks in" switch, for an invite into one store.
  const clockStoreId = manualDraft?.storeIds.length === 1 ? manualDraft.storeIds[0]! : null;
  const clocking = useStoreClocking(clockStoreId, !!manualDraft);

  const invite = trpc.admin.memberInviteByTgId.useMutation({
    onError: errToast('common.errors.actionFailed'),
  });
  const appConfig = trpc.system.appConfig.useQuery(undefined, {
    staleTime: STALE.long,
  });
  const createInvite = trpc.admin.memberInviteCreate.useMutation({
    onSuccess: () => void utils.admin.memberInviteList.invalidate(),
    onError: errToast('common.errors.actionFailed'),
  });
  // ADM1-15: an invite the clipboard refused, shown to copy by hand. The
  // server keeps no copy of the token, so it can't be fetched again.
  const [uncopiedInvite, setUncopiedInvite] = useState<string | null>(null);
  /**
   * Creates a link invite, then copies or shares it. ADM1-15 (2026-11-11):
   * the copy is asked for here, inside the tap, and filled in when the
   * link arrives; WebKit (Telegram on iOS) refused the write that waited
   * for the server (lib/clipboard).
   */
  const sendLinkInvite = (input: { roleSlug: string; storeIds: string[] }) => {
    const NO_BOT = 'people.inviteNoBot';
    const sent = createInvite.mutateAsync(input).then((data) => {
      const link = makeInviteLink(appConfig.data?.botUsername, data.token);
      if (!link) throw new Error(NO_BOT);
      const message = i18n.t('people.inviteMessage', { org: session?.member.orgName ?? '' });
      return { link, message, text: `${message}\n${link}` };
    });
    const failed = (err: unknown) => {
      // A refused create was already reported by the mutation's onError.
      if (err instanceof Error && err.message === NO_BOT) toast.error(i18n.t(NO_BOT));
    };
    if (linkAction === 'copy') {
      const text = sent.then((s) => s.text);
      void copyText(text).then((copied) => {
        setLinkDraft(null);
        if (copied) toast.success(i18n.t('admin.toast.linkCopied'));
        else void text.then(setUncopiedInvite);
      }, failed);
      return;
    }
    void sent.then(({ link, message }) => {
      const shareUrl = makeShareLink({ url: link, text: message });
      const tg = getTg();
      if (tg) {
        tg.openTelegramLink(shareUrl);
      } else if (typeof window !== 'undefined') {
        window.open(shareUrl, '_blank');
      }
      setLinkDraft(null);
    }, failed);
  };

  const freshDraft = (): InviteDraft => ({
    tgUserId: '',
    displayName: '',
    roleSlug: '',
    storeIds,
    clocksIn: false,
  });

  return (
    <>
      <InviteHubSheet
        open={open}
        onClose={onClose}
        onPickManual={() => {
          onClose();
          setManualDraft(freshDraft());
        }}
        onPickLink={(action) => {
          onClose();
          setLinkAction(action);
          setLinkDraft(freshDraft());
        }}
      />
      <ManualInviteSheet
        mode="tgid"
        actor={actor}
        preferOrgTier={preferOrgTier}
        clocksInOffered={clocking.offered}
        draft={manualDraft}
        setDraft={setManualDraft}
        onSubmit={(roleSlug) => {
          if (!manualDraft) return;
          const draft = manualDraft;
          const clockIn = clocking.offered && draft.clocksIn && clockStoreId;
          invite
            .mutateAsync({
              tgUserId: draft.tgUserId.trim(),
              displayName: draft.displayName || undefined,
              roleSlug,
              storeIds: draft.storeIds,
            })
            .then(async (data) => {
              void utils.admin.memberList.invalidate();
              // A3: the person is a member at once, so clocking is
              // switched on for them right away (attendance.memberSet).
              if (clockIn) await clocking.set(data.memberId, true).catch(() => undefined);
              toast[data.created ? 'success' : 'info'](
                data.created ? i18n.t('admin.toast.memberAdded') : i18n.t('admin.toast.userExists'),
              );
              setManualDraft(null);
            })
            .catch(() => undefined);
        }}
        pending={invite.isPending || clocking.pending}
      />
      <ManualInviteSheet
        mode="link"
        actor={actor}
        preferOrgTier={preferOrgTier}
        clocksInOffered={false}
        draft={linkDraft}
        setDraft={setLinkDraft}
        onSubmit={(roleSlug) => {
          if (!linkDraft) return;
          sendLinkInvite({ roleSlug, storeIds: linkDraft.storeIds });
        }}
        pending={createInvite.isPending}
      />
      <InviteCopySheet text={uncopiedInvite} onClose={() => setUncopiedInvite(null)} />
    </>
  );
}
