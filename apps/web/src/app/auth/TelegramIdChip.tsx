import { useToast } from '@compass/ui';
import { getTg, haptic } from '../../lib/telegram';
import { useI18n } from '../../hooks/useI18n';

/**
 * A Telegram user id (the caller's by default), tap to copy. Review
 * COREWEB1-25 (2026-11-11): nothing said it copies, and a vibration was
 * the only answer (none in a browser). It is named "tap to copy" and
 * says whether it did.
 */
export function TelegramIdChip({ id }: { id?: string } = {}) {
  const i18n = useI18n();
  const toast = useToast();
  const tgUserId = id ?? getTg()?.initDataUnsafe?.user?.id;
  if (!tgUserId) return null;
  const failed = () => toast.error(i18n.t('admin.toast.couldNotCopy'));
  return (
    <button
      type="button"
      aria-label={i18n.t('auth.copyTelegramId', { id: String(tgUserId) })}
      onClick={() => {
        if (!navigator.clipboard) {
          failed();
          return;
        }
        void navigator.clipboard.writeText(String(tgUserId)).then(() => {
          haptic('success');
          toast.success(i18n.t('auth.telegramIdCopied'));
        }, failed);
      }}
      className="press rounded-full bg-[var(--c-surface-2)] px-4 py-2 font-mono text-old-body ring-hairline"
    >
      {tgUserId}
    </button>
  );
}
