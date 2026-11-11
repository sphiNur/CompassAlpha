import { Banner, Button, Sheet, Textarea, useToast } from '@compass/ui';
import { copyText } from '../../../lib/clipboard';
import { useI18n } from '../../../hooks/useI18n';

/**
 * ADM1-15 (2026-11-11): an invite link the clipboard refused. The server
 * keeps no copy of the token, so the link would be lost and the pending
 * invite left behind. It is shown here to select by hand, and the button
 * tries again (a new tap may write the clipboard).
 */
export function InviteCopySheet({ text, onClose }: { text: string | null; onClose: () => void }) {
  const i18n = useI18n();
  const toast = useToast();
  const copy = () => {
    if (text === null) return;
    void copyText(text).then((copied) => {
      if (!copied) {
        toast.error(i18n.t('admin.toast.couldNotCopy'));
        return;
      }
      toast.success(i18n.t('admin.toast.linkCopied'));
      onClose();
    });
  };
  return (
    <Sheet
      open={text !== null}
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t('admin.invite.link.copyTitle')}
      footer={
        <Button block size="lg" onClick={copy}>
          {i18n.t('people.inviteCopyLink')}
        </Button>
      }
    >
      {text !== null ? (
        <div className="flex flex-col gap-3 py-3">
          <Banner tone="warn" title={i18n.t('admin.toast.couldNotCopy')} />
          <Textarea
            readOnly
            value={text}
            rows={5}
            aria-label={i18n.t('admin.invite.link.copyTitle')}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      ) : null}
    </Sheet>
  );
}
