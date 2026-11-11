/**
 * The punch flow (punchFlow.ts) wired to the server, the timers and the
 * clock page, and rendered: see punchFlow.ts for what a punch does.
 */
import { useRef, useState, useSyncExternalStore } from 'react';
import type { CatalogKey } from '@compass/i18n';
import { haptic } from '../../lib/telegram';
import { devicePlatform } from '../../lib/attendanceDevice';
import { useErrToast } from '../../hooks/useErrToast';
import { newIdempotencyKey, trpc } from '../../lib/trpc';
import { punchFlow } from './punchFlow';

export function usePunchFlow(opts: {
  storeId: string;
  deviceId: string | null;
  /** The phone's person agrees to the face check first. */
  onConsent: () => void;
  /** The phone's person has no approved face yet. */
  onEnroll: () => void;
  /** Start over through the page (location, consent): for oneself, or for a colleague. */
  onAgain: (identify: boolean, notice?: CatalogKey) => void;
}) {
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  // The key of the photos being sent, read when the request goes out.
  const idem = useRef<{ idempotencyKey?: string }>({}).current;
  const challengeCall = trpc.attendance.livenessChallenge.useMutation();
  const punchCall = trpc.attendance.punch.useMutation({ trpc: { context: idem } });
  const undoCall = trpc.attendance.punchUndo.useMutation();
  // The flow outlives renders; it reads the latest of these when it acts.
  const live = useRef({ opts, utils, errToast, challengeCall, punchCall, undoCall });
  live.current = { opts, utils, errToast, challengeCall, punchCall, undoCall };

  const [flow] = useState(() =>
    punchFlow({
      where: () => ({ storeId: live.current.opts.storeId, deviceId: live.current.opts.deviceId }),
      challenge: (input) => live.current.challengeCall.mutateAsync(input),
      punch: (input, key) => {
        idem.idempotencyKey = key;
        return live.current.punchCall.mutateAsync(input);
      },
      undo: (input) => live.current.undoCall.mutateAsync(input),
      newKey: newIdempotencyKey,
      platform: devicePlatform,
      now: () => Date.now(),
      later: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      haptic,
      refresh: () => void live.current.utils.attendance.me.invalidate(),
      failed: (err) => live.current.errToast('attendance.errors.punchFailed')(err),
      onConsent: () => live.current.opts.onConsent(),
      onEnroll: () => live.current.opts.onEnroll(),
      onAgain: (identify, notice) => live.current.opts.onAgain(identify, notice),
    }),
  );
  const { flow: open, last, preparing } = useSyncExternalStore(flow.subscribe, flow.getState);

  return {
    /** The challenge for a new punch is on its way. */
    preparing,
    /** The sheet is open. */
    open: open !== null,
    /** The latest punch result, for the page's own line once the sheet is closed. */
    last,
    clearLast: flow.clearLast,
    start: flow.start,
    undo: flow.undo,
    undoPending: undoCall.isPending,
    /** The kind asked for in the open sheet; null = a colleague's, or none open. */
    kind: open?.attempt.kind ?? null,
    sheet: {
      view: open?.view ?? null,
      identifying: open?.attempt.identify ?? false,
      reasonDraft: open?.attempt.reason ?? '',
      undoPending: undoCall.isPending,
      onCaptured: flow.onCaptured,
      onReason: flow.onReason,
      onRetry: flow.onRetry,
      onResend: flow.onResend,
      onForSelf: flow.onForSelf,
      onUndo: flow.undo,
      onClose: flow.onClose,
    },
  };
}
