import type { ReactNode } from 'react';
import {
  Banner,
  IconShare,
  LoadingState,
  QueryErrorBanner,
  SectionRow,
  Sheet,
  rowGroupClass,
} from '@compass/ui';
import { STALE } from '../../../../config/timings';
import { trpc } from '../../../../lib/trpc';
import { useI18n } from '../../../../hooks/useI18n';
import { PendingInvitesList } from './PendingInvitesList';

/**
 * Telegram-native invite hub. The first option is "Share via Telegram"
 * which opens Telegram's contact picker pre-filled with an invite link
 * the recipient accepts in the Mini App. The manual option adds someone
 * by Telegram id; DX-ADM-6: they find it by opening the Mini App, whose
 * no-access screen shows it (production runs no bot answering /id).
 */
export function InviteHubSheet({
  open,
  onClose,
  storePicker,
  onPickManual,
  onPickLink,
}: {
  open: boolean;
  onClose: () => void;
  /** S2: which store, asked before the method when there are several. */
  storePicker?: ReactNode;
  onPickManual: () => void;
  onPickLink: (action: 'share' | 'copy') => void;
}) {
  const i18n = useI18n();
  const cfgQuery = trpc.system.appConfig.useQuery(undefined, {
    enabled: open,
    staleTime: STALE.long,
  });

  const botUsername = cfgQuery.data?.botUsername?.replace(/^@/, '') ?? null;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={i18n.t('people.inviteTitle')}
      description={i18n.t('people.inviteHint')}
    >
      {/* Review ADM1-13 (2026-11-12): the kit's rows (UI-16), not three
          hand-drawn buttons. A link needs the bot: without it (or while
          the setting loads) the link rows are not offered, and the
          reason is said once instead of under two greyed-out rows. */}
      <div className="flex flex-col gap-2 py-3">
        {storePicker}
        {botUsername ? (
          <>
            <ul className={rowGroupClass} role="list">
              <SectionRow
                icon={<IconShare size={20} />}
                label={i18n.t('people.inviteViaTelegram')}
                hint={i18n.t('people.inviteViaTelegramHint')}
                onClick={() => onPickLink('share')}
              />
              <SectionRow
                icon={<IconShare size={20} />}
                label={i18n.t('people.inviteCopyLink')}
                hint={i18n.t('people.inviteCopyLinkHint')}
                onClick={() => onPickLink('copy')}
              />
            </ul>
            <div className="my-2 text-center text-old-label text-[var(--c-fg-subtle)]">
              {i18n.t('people.inviteOr')}
            </div>
          </>
        ) : cfgQuery.isLoading ? (
          <LoadingState variant="compact" />
        ) : cfgQuery.isError && !cfgQuery.data ? (
          <QueryErrorBanner query={cfgQuery} />
        ) : (
          <Banner tone="warn">{i18n.t('people.inviteNoBot')}</Banner>
        )}

        <ul className={rowGroupClass} role="list">
          <SectionRow
            label={i18n.t('people.inviteByTgId')}
            hint={i18n.t('people.inviteByTgIdHint')}
            onClick={onPickManual}
          />
        </ul>

        <PendingInvitesList enabled={open} />
      </div>
    </Sheet>
  );
}
