/**
 * The problem form: how much arrived, why, and an optional photo.
 * Review CONF-07: moved out of ConfirmPage, which keeps the mutation.
 */
import {
  Button,
  FieldError,
  FieldLabel,
  Input,
  PhotoCapture,
  Sheet,
  type PhotoUploader,
} from '@compass/ui';
import { useI18n, useUnitLabel } from '../../hooks/useI18n';
import { formatQty } from '../../lib/format';
import { DECISION_LABEL, RECEIVED_QTY_MESSAGE, type IssueFormCheck } from './confirmLogic';
import type { IssueForm } from './useIssueForm';

export function IssueSheet({
  form,
  check,
  saving,
  itemName,
  photoUploader,
  onSave,
}: {
  form: IssueForm;
  check: IssueFormCheck | null;
  /** The verdict is being sent. */
  saving: boolean;
  /** The product's name, for the title (DLV-10). */
  itemName: string | undefined;
  /** Absent when uploads are off: the photo is kept inline. */
  photoUploader: PhotoUploader | undefined;
  onSave: () => void;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const draft = form.draft;
  const status = draft ? i18n.t(DECISION_LABEL[draft.status]) : '';
  const receivedError =
    draft && check?.shownReceivedProblem
      ? i18n.t(RECEIVED_QTY_MESSAGE[check.shownReceivedProblem], { max: formatQty(draft.splitQty) })
      : null;
  const saveReason =
    check?.saveBlockedBy === 'photo'
      ? i18n.t('confirm.issue.photoUploading')
      : check?.saveBlockedBy === 'note'
        ? i18n.t('confirm.issue.noteRequired')
        : null;
  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => {
        // M3.10: pin the sheet open while a confirm mutation is in
        // flight. The receiver may have typed an issue note + attached
        // a photo; if the network is slow and they swipe-down, the
        // local state clears and a subsequent failure produces an error
        // toast with all that work lost. Mutation success closes the
        // sheet naturally (closeFor).
        if (!open && saving) return;
        // 2026-10-21 audit C-20: drop the draft on cancel too — it used
        // to be cleared only on success, so a cancelled note/photo
        // reappeared on the next item's issue sheet.
        if (!open) form.close();
      }}
      // DLV-10 (2026-10-30): the title named the verdict but not the item.
      title={
        itemName
          ? i18n.t('confirm.issue.markItemAs', { item: itemName, status })
          : i18n.t('confirm.issue.markAs', { status })
      }
      description={i18n.t('confirm.issue.describe')}
      // M1.9-fix (2026-05-07): autofocusing the issue note input
      // popped the iOS keyboard mid-slideUp, pushing the
      // PhotoCapture row below the fold. Receiver who wants to
      // attach a photo first now sees both inputs.
      // DX-DLV-08 (2026-11-01): focus still moves into the form — to
      // its title, which pops no keyboard — instead of staying on the
      // chip behind the scrim.
      focusTitleOnOpen
      footer={
        // M3.49 (2026-05-23): dropped !getTg() — the in-page
        // PageMainButton sits behind any open sheet, so we
        // ALWAYS render the sheet's own footer button now.
        <div className="flex flex-col gap-2">
          {saveReason ? (
            <p
              id="issue-save-reason"
              role="status"
              className="text-center text-old-label text-[var(--c-fg-muted)]"
            >
              {saveReason}
            </p>
          ) : null}
          <Button
            block
            disabled={!check?.canSave}
            aria-describedby={saveReason ? 'issue-save-reason' : undefined}
            loading={saving}
            onClick={onSave}
          >
            {i18n.t('confirm.issue.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        {/* 2026-10-21 CA-06: inventory books what actually arrived.
            Required for a short line; for a wrong or spoiled item it
            starts at the delivered qty (2026-11-05 owner) and is
            lowered to what is usable. */}
        {draft ? (
          <div className="flex flex-col gap-1">
            {/* DLV-10: once typed into, the field had no visible label.
                DX-DLV-07: the label is the field's name (no placeholder
                or aria-label repeating it), and the error waits until
                the field was used or Save was tried. */}
            <FieldLabel htmlFor="issue-received">
              {i18n.t('confirm.issue.receivedQty', {
                max: formatQty(draft.splitQty),
                unit: unitLabel(draft.unit, draft.splitQty),
              })}
            </FieldLabel>
            <Input
              id="issue-received"
              type="number"
              // The line below says what is wrong, once the field was used.
              formatError="none"
              value={draft.received}
              onChange={(e) => form.setReceived(e.target.value)}
              onBlur={form.touchReceived}
              invalid={!!receivedError}
              aria-describedby={receivedError ? 'issue-received-error' : undefined}
            />
            {/* CONF-21: the kit's field error, as on every other form. */}
            {receivedError ? (
              <FieldError id="issue-received-error" className="mt-0">
                {receivedError}
              </FieldError>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor="issue-note">{i18n.t('confirm.issue.noteLabel')}</FieldLabel>
          <Input
            id="issue-note"
            value={draft?.note ?? ''}
            onChange={(e) => form.setNote(e.target.value)}
            placeholder={i18n.t('confirm.issue.placeholder')}
            maxLength={500}
            required
            aria-required
            aria-invalid={check?.noteMissingShown ? true : undefined}
            aria-describedby={check?.noteMissingShown ? 'issue-note-error' : undefined}
          />
          {check?.noteMissingShown ? (
            <FieldError id="issue-note-error" className="mt-0">
              {i18n.t('confirm.issue.noteRequired')}
            </FieldError>
          ) : null}
        </div>
        <PhotoCapture
          label={i18n.t('confirm.issue.photoOptional')}
          value={draft?.photo ?? null}
          onCapture={form.setPhoto}
          onClear={() => form.setPhoto(null)}
          uploader={photoUploader}
          onBusyChange={form.setPhotoUploading}
        />
      </div>
    </Sheet>
  );
}
