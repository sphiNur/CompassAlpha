/**
 * The face-check consent (2026-11-06), asked in the app before a face
 * photo of this person is first used to check their punches. What is
 * kept, who sees it, and that it can be withdrawn on this screen.
 */
import { Button, Sheet } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';

export function FaceConsentSheet({
  open,
  pending,
  onAgree,
  onCancel,
}: {
  open: boolean;
  pending: boolean;
  onAgree: () => void;
  onCancel: () => void;
}) {
  const i18n = useI18n();
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !pending && onCancel()}
      title={i18n.t('attendance.consent.title')}
      description={i18n.t('attendance.consent.intro')}
    >
      <div className="flex flex-col gap-3 py-3">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-old-body text-[var(--c-fg)]">
          <li>{i18n.t('attendance.consent.kept')}</li>
          <li>{i18n.t('attendance.consent.who')}</li>
          <li>{i18n.t('attendance.consent.withdrawNote')}</li>
        </ul>
        <Button block size="lg" loading={pending} onClick={onAgree}>
          {i18n.t('attendance.consent.agree')}
        </Button>
        <Button block variant="ghost" disabled={pending} onClick={onCancel}>
          {i18n.t('attendance.consent.notNow')}
        </Button>
      </div>
    </Sheet>
  );
}
