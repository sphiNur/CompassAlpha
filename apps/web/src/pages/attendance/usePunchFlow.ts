/**
 * One punch from the clock page (owner, 2026-11-07, "straight on"): the
 * liveness challenge, the camera, the punch sent the moment the last face
 * frame is in, and whatever the server says next, all in PunchSheet.
 *
 * - The photos of a punch keep one idempotency key. When the answer is
 *   lost (a slow cross-border link, the 120 s timeout) the same photos go
 *   again with the same key, and a punch the server already recorded
 *   comes back as recorded instead of becoming a second one.
 * - A clock-out past the shift is asked why before the camera when the
 *   server can tell (the challenge says so); a colleague's once their face
 *   is known, and then the same photos go again with the reason.
 * - "Not <name>": a colleague clocked on this phone can be taken back
 *   for two minutes; the face check then starts again.
 * - A wait can be closed once it has lasted WAIT_CLOSABLE_MS. An answer
 *   that comes after that updates the page, not the sheet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ATTENDANCE_UNDO_WINDOW_MS } from '@compass/contracts/limits';
import type { CatalogKey } from '@compass/i18n';
import { haptic } from '../../hooks/useTelegram';
import { devicePlatform } from '../../lib/attendanceDevice';
import { errorTextOf } from '../../lib/errorText';
import { useErrToast } from '../../lib/errToast';
import { newIdempotencyKey, trpc } from '../../lib/trpc';
import type { Act } from './faceActs';
import type { PunchPhotos, Turn } from './PunchCamera';
import { punchOutcome, refusalHint, type PunchKind } from './punchOutcome';
import { WAIT_CLOSABLE_MS, type PunchResult, type PunchView } from './PunchSheet';

type Fix = { lat: number; lng: number; accuracy: number };
type Challenge = { token: string; steps: Turn[]; acts: Act[]; at: number };

type Attempt = {
  identify: boolean;
  location: Fix | null;
  /** The kind asked for; null = a colleague, whose kind the server picks. */
  kind: PunchKind | null;
  challenge: Challenge;
  /** The overtime reason, once asked. */
  reason: string | null;
};

type Flow = {
  attempt: Attempt;
  view: PunchView;
  /** The photos taken, kept to go again (a lost answer, a reason asked after). */
  photos: PunchPhotos | null;
  /** The idempotency key those photos go with. */
  key: string | null;
  /** Automatic resends of those photos so far. */
  resent: number;
  /** Mounts the camera afresh for each try. */
  round: number;
};

/** The waits before each automatic resend of a punch whose answer did not come. */
const RESEND_WAITS_MS = [1_500, 4_000];
/** A challenge older than this is renewed after the overtime reason (it lasts three minutes). */
const CHALLENGE_FRESH_MS = 60_000;
/** "Not <name>" goes a little before the server's window closes, for the trip there. */
const UNDO_MARGIN_MS = 15_000;

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
  const { storeId, deviceId } = opts;
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  // The key of the photos being sent, read when the request goes out.
  const idem = useRef<{ idempotencyKey?: string }>({}).current;
  const challengeCall = trpc.attendance.livenessChallenge.useMutation();
  const punchCall = trpc.attendance.punch.useMutation({ trpc: { context: idem } });
  const undoCall = trpc.attendance.punchUndo.useMutation();
  const [flow, setFlowState] = useState<Flow | null>(null);
  const flowRef = useRef<Flow | null>(null);
  const setFlow = useCallback((f: Flow | null) => {
    flowRef.current = f;
    setFlowState(f);
  }, []);
  const [last, setLast] = useState<PunchResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // "Not <name>" goes away when its time is up.
  useEffect(() => {
    const until = last?.undoUntil;
    if (!until) return;
    const id = last.id;
    const t = setTimeout(
      () => setLast((l) => (l && l.id === id ? { ...l, undoUntil: null } : l)),
      Math.max(0, until - Date.now()),
    );
    return () => clearTimeout(t);
  }, [last]);

  const fetchChallenge = async (identify: boolean, location: Fix | null, force: boolean) => {
    const c = await challengeCall.mutateAsync({
      storeId,
      identify: identify || undefined,
      deviceId: deviceId ?? undefined,
      location: location ?? undefined,
      force: force || undefined,
    });
    return {
      challenge: { token: c.token, steps: c.steps, acts: c.acts ?? [], at: Date.now() },
      overtimeMinutes: c.overtimeMinutes ?? 0,
    };
  };

  const cameraView = (a: Attempt, round: number, notice: CatalogKey | null): PunchView => ({
    at: 'camera',
    round,
    turns: a.challenge.steps,
    acts: a.challenge.acts,
    notice,
  });

  const failedView = (
    title: string,
    action: Extract<PunchView, { at: 'failed' }>['action'],
    vars: Record<string, string | number> = {},
    body: string | null = null,
  ): PunchView => ({
    at: 'failed',
    title: title as CatalogKey,
    vars,
    body: body as CatalogKey | null,
    action,
  });

  /** A new punch: its challenge, then the overtime reason or the camera. */
  const start = async (
    identify: boolean,
    location: Fix | null,
    kind: PunchKind | null,
    notice?: CatalogKey,
  ) => {
    setLast(null);
    setPreparing(true);
    try {
      const { challenge, overtimeMinutes } = await fetchChallenge(identify, location, false);
      const attempt: Attempt = { identify, location, kind, challenge, reason: null };
      setFlow({
        attempt,
        photos: null,
        key: null,
        resent: 0,
        round: 1,
        view:
          !identify && overtimeMinutes > 0
            ? { at: 'reason', minutes: overtimeMinutes, name: null, then: 'camera' }
            : cameraView(attempt, 1, notice ?? null),
      });
    } catch (err) {
      errToast('attendance.errors.punchFailed')(err);
    } finally {
      setPreparing(false);
    }
  };

  /** Another face check for the same punch: a fresh challenge, the camera again. */
  const again = async (f: Flow, force: boolean, notice: CatalogKey | null) => {
    const waiting: Flow = { ...f, view: { at: 'wait', label: 'preparing', since: Date.now() } };
    setFlow(waiting);
    try {
      const { challenge } = await fetchChallenge(f.attempt.identify, f.attempt.location, force);
      // Closed while it was coming (ATT-04): stays closed.
      if (flowRef.current !== waiting) return;
      const attempt = { ...f.attempt, challenge };
      const round = f.round + 1;
      setFlow({
        attempt,
        photos: null,
        key: null,
        resent: 0,
        round,
        view: cameraView(attempt, round, notice),
      });
    } catch (err) {
      if (flowRef.current !== waiting) return;
      const shown = errorTextOf(err, 'attendance.errors.punchFailed');
      setFlow({ ...f, view: failedView(shown.key, 'retry', shown.vars) });
    }
  };

  type Punched = Awaited<ReturnType<typeof punchCall.mutateAsync>>;

  const recorded = (f: Flow, data: Punched) => {
    haptic('success');
    const result: PunchResult = {
      id: data.id,
      kind: data.kind,
      time: data.time,
      forName: data.forName,
      flagged: data.newDevice,
      already: false,
      undoUntil: data.forName ? Date.now() + ATTENDANCE_UNDO_WINDOW_MS - UNDO_MARGIN_MS : null,
    };
    setLast(result);
    // Closed while it was on its way (ATT-04): the page's own line says it.
    if (flowRef.current === f) setFlow({ ...f, view: { at: 'done', result } });
    void utils.attendance.me.invalidate();
  };

  const refused = (f: Flow, err: unknown) => {
    // Closed while it was on its way (ATT-04): the page shows what was
    // recorded, and nothing is sent again behind the person's back.
    if (flowRef.current !== f) {
      void utils.attendance.me.invalidate();
      return;
    }
    const out = punchOutcome(err, f.attempt.identify ? null : f.attempt.kind);
    switch (out.next) {
      case 'resend': {
        const wait = RESEND_WAITS_MS[f.resent];
        const { photos, key } = f;
        if (wait !== undefined && photos && key) {
          setTimeout(() => {
            if (flowRef.current === f) send({ ...f, resent: f.resent + 1 }, photos, key);
          }, wait);
          return;
        }
        // No answer is not "not recorded" (ATT-03): it may have got
        // through. The sheet says so, the same photos and key check it,
        // and the page underneath reads what is recorded.
        haptic('error');
        setFlow({
          ...f,
          view: failedView(
            'attendance.punch.netFailed',
            'resend',
            {},
            'attendance.punch.netFailedBody',
          ),
        });
        void utils.attendance.me.invalidate();
        return;
      }
      case 'turns':
        haptic('warning');
        void again(f, true, 'attendance.punch.oneMore');
        return;
      case 'restart':
        void again(f, f.attempt.challenge.steps.length > 0, 'attendance.punch.restart');
        return;
      case 'reason':
        haptic('warning');
        setFlow({
          ...f,
          view: { at: 'reason', minutes: out.minutes, name: out.name, then: 'send' },
        });
        return;
      case 'consent':
        setFlow(null);
        optsRef.current.onConsent();
        return;
      case 'enroll':
        setFlow(null);
        void utils.attendance.me.invalidate();
        optsRef.current.onEnroll();
        return;
      case 'already': {
        haptic('success');
        const result: PunchResult = {
          id: '',
          kind: out.kind,
          time: out.time,
          forName: out.name,
          flagged: false,
          already: true,
          undoUntil: null,
        };
        setLast(result);
        setFlow({ ...f, view: { at: 'done', result } });
        void utils.attendance.me.invalidate();
        return;
      }
      case 'retry':
        haptic('error');
        setFlow({ ...f, view: failedView(out.key, 'retry', {}, refusalHint(out.key)) });
        return;
      case 'forSelf':
        haptic('error');
        setFlow({ ...f, view: failedView(out.key, 'forSelf') });
        return;
      case 'stop':
        haptic('error');
        setFlow({ ...f, view: failedView(out.key, null, out.vars) });
        void utils.attendance.me.invalidate();
        return;
    }
  };

  /** Sends the photos; the same photos always go with the same key. */
  const send = (f: Flow, photos: PunchPhotos, key: string) => {
    if (!deviceId) return;
    // An automatic resend goes on with the same wait.
    const since = f.view.at === 'wait' ? f.view.since : Date.now();
    const sending: Flow = { ...f, photos, key, view: { at: 'wait', label: 'checking', since } };
    setFlow(sending);
    idem.idempotencyKey = key;
    const a = f.attempt;
    punchCall
      .mutateAsync({
        storeId,
        kind: a.identify ? undefined : (a.kind ?? undefined),
        deviceId,
        platform: devicePlatform(),
        location: a.location,
        photos: { face: photos.face },
        liveness: {
          token: a.challenge.token,
          left: photos.left,
          right: photos.right,
          blink: photos.blink,
          mouth: photos.mouth,
        },
        identify: a.identify || undefined,
        overtimeReason: a.reason ?? undefined,
      })
      .then(
        (data) => recorded(sending, data),
        (err: unknown) => refused(sending, err),
      );
  };

  const onCaptured = (photos: PunchPhotos) => {
    const f = flowRef.current;
    if (f) send(f, photos, newIdempotencyKey());
  };

  const onReason = (reason: string) => {
    const f = flowRef.current;
    if (!f || f.view.at !== 'reason') return;
    const g: Flow = { ...f, attempt: { ...f.attempt, reason } };
    // Asked after the photos: the same photos again, now with the reason
    // (another request body, so another key).
    if (f.view.then === 'send' && f.photos) {
      send(g, f.photos, newIdempotencyKey());
      return;
    }
    // Asked before the camera: a challenge that has gone stale while the
    // reason was typed is renewed first.
    if (Date.now() - g.attempt.challenge.at > CHALLENGE_FRESH_MS) {
      void again(g, g.attempt.challenge.steps.length > 0, null);
      return;
    }
    setFlow({ ...g, view: cameraView(g.attempt, g.round, null) });
  };

  const onRetry = () => {
    const f = flowRef.current;
    if (f) void again(f, f.attempt.identify, null);
  };

  const onResend = () => {
    const f = flowRef.current;
    if (f?.photos && f.key) send({ ...f, resent: 0 }, f.photos, f.key);
  };

  const onForSelf = () => {
    setFlow(null);
    optsRef.current.onAgain(false);
  };

  const onClose = useCallback(() => {
    // Not while the punch is on its way (it may be recorded already), until
    // it has waited WAIT_CLOSABLE_MS (ATT-04).
    const view = flowRef.current?.view;
    if (view?.at === 'wait' && Date.now() - view.since < WAIT_CLOSABLE_MS) return;
    setFlow(null);
  }, [setFlow]);

  /** "Not <name>": take the colleague's punch back, then find the right face. */
  const undo = () => {
    const target = last;
    if (!target?.id || !target.forName || !target.undoUntil) return;
    undoCall.mutateAsync({ storeId, punchId: target.id }).then(
      () => {
        haptic('warning');
        setLast(null);
        setFlow(null);
        void utils.attendance.me.invalidate();
        optsRef.current.onAgain(true, 'attendance.punch.undone');
      },
      (err: unknown) => errToast('attendance.errors.punchFailed')(err),
    );
  };

  return {
    /** The challenge for a new punch is on its way. */
    preparing,
    /** The sheet is open. */
    open: flow !== null,
    /** The latest punch result, for the page's own line once the sheet is closed. */
    last,
    clearLast: () => setLast(null),
    start,
    undo,
    undoPending: undoCall.isPending,
    /** The kind asked for in the open sheet; null = a colleague's, or none open. */
    kind: flow?.attempt.kind ?? null,
    sheet: {
      view: flow?.view ?? null,
      identifying: flow?.attempt.identify ?? false,
      reasonDraft: flow?.attempt.reason ?? '',
      undoPending: undoCall.isPending,
      onCaptured,
      onReason,
      onRetry,
      onResend,
      onForSelf,
      onUndo: undo,
      onClose,
    },
  };
}
