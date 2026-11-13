/**
 * The whole invite: the hub (link or Telegram id), the form, sending the
 * link and the copy-by-hand fallback. D6 (2026-11-13): out of
 * PeopleSection so the Admin home can open it for a manager of one store
 * without the Stores › store › Team detour.
 */
import { useState } from 'react';
import { ConfirmSheet, useToast } from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts/schemas/roles';
import { STALE } from '../../../../config/timings';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { copyText } from '../../../../lib/clipboard';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n, useRoleLabels } from '../../../../hooks/useI18n';
import { getTg } from '../../../../lib/telegram';
import {
  inviteLink as makeInviteLink,
  shareLink as makeShareLink,
} from '../../../../lib/telegramLinks';
import { useStoreClocking } from '../../../attendance/useStoreClocking';
import { InviteCopySheet } from '../InviteCopySheet';
import { type InviteDraft, useActor } from '../shared';
import { existingMemberPrompt } from './inviteConfirm';
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
  /**
   * The stores the form's checklist starts with: the store in context (the
   * top bar's on the Admin home), or none when the person has to pick.
   * UX-23 (2026-11-14): the hub no longer asks for a store of its own; the
   * form's checklist is the one choice.
   */
  storeIds: string[];
  /** The organisation-level list: an org-tier role is the default. */
  preferOrgTier?: boolean;
}) {
  const session = useAuthStore((s) => s.session);
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const roleText = useRoleLabels();
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
  // UX-24: the role and store names the "already a member" question uses
  // (the form loads the same lists).
  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: !!manualDraft });
  const storesQuery = trpc.admin.storeList.useQuery(undefined, { enabled: !!manualDraft });
  /** UX-24: asked before adding a role to someone already in the workspace. */
  const [existing, setExisting] = useState<{
    displayName: string | null;
    roleSlug: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
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

  const inviteInput = (draft: InviteDraft, roleSlug: string) => ({
    tgUserId: draft.tgUserId.trim(),
    displayName: draft.displayName || undefined,
    roleSlug,
    storeIds: draft.storeIds,
  });

  /** Adds the person (new, or confirmed as already here). */
  const addByTgId = (roleSlug: string) => {
    if (!manualDraft) return;
    const draft = manualDraft;
    const clockIn = clocking.offered && draft.clocksIn && clockStoreId;
    invite
      .mutateAsync(inviteInput(draft, roleSlug))
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
      .catch(() => undefined)
      .finally(() => setExisting(null));
  };

  /**
   * UX-24 (2026-11-14): someone already in the workspace is asked about
   * first ("Leo Park is already a member. Add Store staff at Central?");
   * the invite added the role and stores and said so only afterwards. The
   * check is the invite's own, without writing (admin.memberInvitePreview),
   * so a refusal shows here as it would on the invite.
   */
  const submitByTgId = (roleSlug: string) => {
    if (!manualDraft || checking) return;
    setChecking(true);
    utils.admin.memberInvitePreview
      .fetch(inviteInput(manualDraft, roleSlug), { staleTime: 0, gcTime: 0 })
      .then((preview) => {
        if (preview.existing) setExisting({ displayName: preview.displayName, roleSlug });
        else addByTgId(roleSlug);
      }, errToast('common.errors.actionFailed'))
      .finally(() => setChecking(false));
  };

  const existingRole = existing
    ? (rolesQuery.data ?? []).find((r) => r.slug === existing.roleSlug)
    : undefined;
  const prompt = existing
    ? existingMemberPrompt({
        displayName: existing.displayName,
        roleName: existingRole ? roleText.name(existingRole) : existing.roleSlug,
        orgWide: (existingRole?.rank ?? 0) >= ADMIN_RANK,
        storeNames: (storesQuery.data ?? [])
          .filter((st) => manualDraft?.storeIds.includes(st.id))
          .map((st) => st.name),
        separator: i18n.t('common.listSeparator'),
      })
    : null;

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
        onSubmit={submitByTgId}
        pending={checking || invite.isPending || clocking.pending}
      />
      <ConfirmSheet
        open={!!prompt}
        title={prompt ? i18n.t(prompt.title.key, prompt.title.params) : ''}
        body={prompt ? i18n.t(prompt.body.key, prompt.body.params) : undefined}
        confirmLabel={i18n.t('admin.invite.existing.confirm')}
        focusCancel
        pending={invite.isPending || clocking.pending}
        onConfirm={() => {
          if (existing) addByTgId(existing.roleSlug);
        }}
        onCancel={() => setExisting(null)}
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
