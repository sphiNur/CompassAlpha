/**
 * The problem form of the receiving page (short / wrong item / quality):
 * what is being reported, on which line, and what was typed. Review
 * CONF-07: it was eight pieces of state in the page.
 */
import { useState } from 'react';
import { initialReceivedQty, sameLine, type ConfirmDecisionStatus } from './confirmLogic';

/** The line and problem the form reports. */
export interface IssueTarget {
  runId: string;
  skuId: string;
  storeId: string;
  status: ConfirmDecisionStatus;
  /** 2026-10-21 CA-06: this store's split qty, the received-qty ceiling. */
  splitQty: string;
  unit: string | undefined;
}

export interface IssueDraft extends IssueTarget {
  note: string;
  /**
   * 2026-10-21 CA-06: how much of the split actually arrived. Empty for
   * 'short' (must be typed); the delivered qty for 'wrong' / 'quality'
   * (2026-11-05 owner, see initialReceivedQty).
   */
  received: string;
  photo: string | null;
  receivedTouched: boolean;
  saveTried: boolean;
}

/** What a line already holds from an earlier verdict. */
export interface ReportedLine {
  confirmStatus?: string | null;
  confirmNote?: string | null;
  confirmPhotoUrl?: string | null;
  confirmReceivedQty?: string | null;
}

export function useIssueForm() {
  const [draft, setDraft] = useState<IssueDraft | null>(null);
  // CMP-DLV-6: Save waits for a photo that is still uploading. PhotoCapture
  // reports false when the form closes mid-upload.
  const [photoUploading, setPhotoUploading] = useState(false);
  const edit = (patch: Partial<IssueDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  return {
    draft,
    photoUploading,
    setPhotoUploading,
    /**
     * Open the form on a line. DLV-9 (2026-10-30): a problem already
     * reported keeps its note and photo, and the same problem its
     * quantity, so tapping it again corrects it.
     */
    open(target: IssueTarget, line: ReportedLine) {
      const reported = !!line.confirmStatus && line.confirmStatus !== 'ok';
      setDraft({
        ...target,
        note: reported ? (line.confirmNote ?? '') : '',
        photo: reported ? (line.confirmPhotoUrl ?? null) : null,
        received: initialReceivedQty(
          target.status,
          line.confirmStatus === target.status ? line.confirmReceivedQty : null,
          target.splitQty,
        ),
        receivedTouched: false,
        saveTried: false,
      });
    },
    setNote: (note: string) => edit({ note }),
    setReceived: (received: string) => edit({ received, receivedTouched: true }),
    touchReceived: () => edit({ receivedTouched: true }),
    setPhoto: (photo: string | null) => edit({ photo }),
    triedSave: () => edit({ saveTried: true }),
    /** 2026-10-21 audit C-20: closing drops what was typed. */
    close: () => setDraft(null),
    /**
     * Close the form if `sent` was its line and problem. CONF-01
     * (2026-11-09): a quick 正常 answered while another line's form was
     * being filled closed it and cleared the note, photo and quantity.
     */
    closeFor(sent: { runId: string; skuId: string; storeId: string; status: string }) {
      setDraft((d) => (d && sameLine(d, sent) && d.status === sent.status ? null : d));
    },
  };
}

export type IssueForm = ReturnType<typeof useIssueForm>;
