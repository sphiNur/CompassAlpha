import { IconChevronRight, IconShare, Sheet } from '@compass/ui';
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
  onPickManual,
  onPickLink,
}: {
  open: boolean;
  onClose: () => void;
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
      <div className="flex flex-col gap-2 py-3">
        <button
          type="button"
          onClick={() => onPickLink('share')}
          disabled={!botUsername}
          className="press flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2.5 text-left ring-hairline disabled:opacity-50"
        >
          <span className="text-[var(--c-action)]">
            <IconShare size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-old-body font-semibold text-[var(--c-fg)]">
              {i18n.t('people.inviteViaTelegram')}
            </span>
            <span className="mt-0.5 block text-old-label text-[var(--c-fg-muted)]">
              {botUsername ? i18n.t('people.inviteViaTelegramHint') : i18n.t('people.inviteNoBot')}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-[var(--c-fg-subtle)]">
            <IconChevronRight size={16} />
          </span>
        </button>

        <button
          type="button"
          onClick={() => onPickLink('copy')}
          disabled={!botUsername}
          className="press flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2.5 text-left ring-hairline disabled:opacity-50"
        >
          <span className="text-[var(--c-action)]">
            <IconShare size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-old-body font-semibold text-[var(--c-fg)]">
              {i18n.t('people.inviteCopyLink')}
            </span>
            <span className="mt-0.5 block text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('people.inviteCopyLinkHint')}
            </span>
          </span>
        </button>

        <div className="my-2 text-center text-old-label text-[var(--c-fg-subtle)]">
          {i18n.t('people.inviteOr')}
        </div>

        <button
          type="button"
          onClick={onPickManual}
          className="press flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2.5 text-left ring-hairline"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-old-body font-semibold text-[var(--c-fg)]">
              {i18n.t('people.inviteByTgId')}
            </span>
            <span className="mt-0.5 block text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('people.inviteByTgIdHint')}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-[var(--c-fg-subtle)]">
            <IconChevronRight size={16} />
          </span>
        </button>

        <PendingInvitesList enabled={open} />
      </div>
    </Sheet>
  );
}
