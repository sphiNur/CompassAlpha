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
 *
 * The flow runs here without React (review TEST3-08 / ATT-25,
 * 2026-11-10): usePunchFlow supplies the requests, the timers and the
 * page's callbacks and renders the state, and the tests drive the same
 * flow with fakes.
 */
import { ATTENDANCE_UNDO_WINDOW_MS } from '@compass/contracts/limits';
import type { CatalogKey } from '@compass/i18n';
import { errorTextOf } from '../../lib/errorText';
import type { Act } from './faceActs';
import type { PunchPhotos, Turn } from './PunchCamera';
import { punchOutcome, refusalHint, type PunchKind } from './punchOutcome';
import type { PunchResult, PunchView } from './PunchSheet';

export type Fix = { lat: number; lng: number; accuracy: number };
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

export type Flow = {
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
export const RESEND_WAITS_MS = [1_500, 4_000];
/** A challenge older than this is renewed after the overtime reason (it lasts three minutes). */
export const CHALLENGE_FRESH_MS = 60_000;
/** "Not <name>" goes a little before the server's window closes, for the trip there. */
export const UNDO_MARGIN_MS = 15_000;
/**
 * When a wait can be closed (ATT-04, 2026-11-09). A punch carries photos:
 * 120 s per try and two resends could hold the sheet for six minutes.
 */
export const WAIT_CLOSABLE_MS = 30_000;

/** The liveness challenge as the server sends it (the fields read here). */
export interface ChallengeAnswer {
  token: string;
  steps: Turn[];
  acts?: Act[] | null;
  overtimeMinutes?: number | null;
}

export interface ChallengeRequest {
  storeId: string;
  identify?: boolean;
  deviceId?: string;
  location?: Fix;
  force?: boolean;
}

/** A recorded punch as the server sends it (the fields read here). */
export interface Punched {
  id: string;
  kind: PunchKind;
  time: string;
  forName: string | null;
  newDevice: boolean;
}

export interface PunchRequest {
  storeId: string;
  kind?: PunchKind;
  deviceId: string;
  platform: string;
  location: Fix | null;
  photos: { face: string };
  liveness: Omit<PunchPhotos, 'face'> & { token: string };
  identify?: boolean;
  overtimeReason?: string;
}

export interface PunchFlowDeps {
  /** The store and this phone's id, as the page has them now. */
  where(): { storeId: string; deviceId: string | null };
  challenge(input: ChallengeRequest): Promise<ChallengeAnswer>;
  /** Sends a punch with this idempotency key. */
  punch(input: PunchRequest, idempotencyKey: string): Promise<Punched>;
  undo(input: { storeId: string; punchId: string }): Promise<unknown>;
  newKey(): string;
  platform(): string;
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel. */
  later(fn: () => void, ms: number): () => void;
  haptic(kind: 'success' | 'warning' | 'error'): void;
  /** Re-reads what is recorded for the page underneath. */
  refresh(): void;
  /** A punch that could not start, or an undo refused: the error toast. */
  failed(err: unknown): void;
  /** The phone's person agrees to the face check first. */
  onConsent(): void;
  /** The phone's person has no approved face yet. */
  onEnroll(): void;
  /** Start over through the page (location, consent): for oneself, or for a colleague. */
  onAgain(identify: boolean, notice?: CatalogKey): void;
}

export interface PunchFlowState {
  /** The open sheet's punch; null = no sheet. */
  flow: Flow | null;
  /** The latest punch result, for the page's own line once the sheet is closed. */
  last: PunchResult | null;
  /** The challenge for a new punch is on its way. */
  preparing: boolean;
}

function cameraView(a: Attempt, round: number, notice: CatalogKey | null): PunchView {
  return { at: 'camera', round, turns: a.challenge.steps, acts: a.challenge.acts, notice };
}

// Review COREWEB1-31 (2026-11-12): keys all the way from the server's
// answer, so nothing here is cast.
function failedView(
  title: CatalogKey,
  action: Extract<PunchView, { at: 'failed' }>['action'],
  vars: Record<string, string | number> = {},
  body: CatalogKey | null = null,
): PunchView {
  return { at: 'failed', title, vars, body, action };
}

export function punchFlow(deps: PunchFlowDeps) {
  let state: PunchFlowState = { flow: null, last: null, preparing: false };
  const listeners = new Set<() => void>();
  let cancelUndoExpiry: (() => void) | null = null;

  const set = (next: Partial<PunchFlowState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const setFlow = (flow: Flow | null) => set({ flow });

  // "Not <name>" goes away when its time is up.
  const setLast = (last: PunchResult | null) => {
    cancelUndoExpiry?.();
    cancelUndoExpiry = null;
    set({ last });
    const until = last?.undoUntil;
    if (!last || !until) return;
    const id = last.id;
    cancelUndoExpiry = deps.later(
      () => {
        if (state.last && state.last.id === id) setLast({ ...state.last, undoUntil: null });
      },
      Math.max(0, until - deps.now()),
    );
  };

  const fetchChallenge = async (identify: boolean, location: Fix | null, force: boolean) => {
    const { storeId, deviceId } = deps.where();
    const c = await deps.challenge({
      storeId,
      identify: identify || undefined,
      deviceId: deviceId ?? undefined,
      location: location ?? undefined,
      force: force || undefined,
    });
    return {
      challenge: { token: c.token, steps: c.steps, acts: c.acts ?? [], at: deps.now() },
      overtimeMinutes: c.overtimeMinutes ?? 0,
    };
  };

  /** A new punch: its challenge, then the overtime reason or the camera. */
  const start = async (
    identify: boolean,
    location: Fix | null,
    kind: PunchKind | null,
    notice?: CatalogKey,
  ) => {
    setLast(null);
    set({ preparing: true });
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
      deps.failed(err);
    } finally {
      set({ preparing: false });
    }
  };

  /** Another face check for the same punch: a fresh challenge, the camera again. */
  const again = async (f: Flow, force: boolean, notice: CatalogKey | null) => {
    const waiting: Flow = { ...f, view: { at: 'wait', label: 'preparing', since: deps.now() } };
    setFlow(waiting);
    try {
      const { challenge } = await fetchChallenge(f.attempt.identify, f.attempt.location, force);
      // Closed while it was coming (ATT-04): stays closed.
      if (state.flow !== waiting) return;
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
      if (state.flow !== waiting) return;
      const shown = errorTextOf(err, 'attendance.errors.punchFailed');
      setFlow({ ...f, view: failedView(shown.key, 'retry', shown.vars) });
    }
  };

  const recorded = (f: Flow, data: Punched) => {
    deps.haptic('success');
    const result: PunchResult = {
      id: data.id,
      kind: data.kind,
      time: data.time,
      forName: data.forName,
      flagged: data.newDevice,
      already: false,
      undoUntil: data.forName ? deps.now() + ATTENDANCE_UNDO_WINDOW_MS - UNDO_MARGIN_MS : null,
    };
    setLast(result);
    // Closed while it was on its way (ATT-04): the page's own line says it.
    if (state.flow === f) setFlow({ ...f, view: { at: 'done', result } });
    deps.refresh();
  };

  const refused = (f: Flow, err: unknown) => {
    // Closed while it was on its way (ATT-04): the page shows what was
    // recorded, and nothing is sent again behind the person's back.
    if (state.flow !== f) {
      deps.refresh();
      return;
    }
    const out = punchOutcome(err, f.attempt.identify ? null : f.attempt.kind);
    switch (out.next) {
      case 'resend': {
        const wait = RESEND_WAITS_MS[f.resent];
        const { photos, key } = f;
        if (wait !== undefined && photos && key) {
          deps.later(() => {
            if (state.flow === f) send({ ...f, resent: f.resent + 1 }, photos, key);
          }, wait);
          return;
        }
        // No answer is not "not recorded" (ATT-03): it may have got
        // through. The sheet says so, the same photos and key check it,
        // and the page underneath reads what is recorded.
        deps.haptic('error');
        setFlow({
          ...f,
          view: failedView(
            'attendance.punch.netFailed',
            'resend',
            {},
            'attendance.punch.netFailedBody',
          ),
        });
        deps.refresh();
        return;
      }
      case 'turns':
        deps.haptic('warning');
        void again(f, true, 'attendance.punch.oneMore');
        return;
      case 'restart':
        void again(f, f.attempt.challenge.steps.length > 0, 'attendance.punch.restart');
        return;
      case 'reason':
        deps.haptic('warning');
        setFlow({
          ...f,
          view: { at: 'reason', minutes: out.minutes, name: out.name, then: 'send' },
        });
        return;
      case 'consent':
        setFlow(null);
        deps.onConsent();
        return;
      case 'enroll':
        setFlow(null);
        deps.refresh();
        deps.onEnroll();
        return;
      case 'already': {
        deps.haptic('success');
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
        deps.refresh();
        return;
      }
      case 'retry':
        deps.haptic('error');
        setFlow({ ...f, view: failedView(out.key, 'retry', {}, refusalHint(out.key)) });
        return;
      case 'forSelf':
        deps.haptic('error');
        setFlow({ ...f, view: failedView(out.key, 'forSelf') });
        return;
      case 'stop':
        deps.haptic('error');
        setFlow({ ...f, view: failedView(out.key, null, out.vars) });
        deps.refresh();
        return;
    }
  };

  /** Sends the photos; the same photos always go with the same key. */
  const send = (f: Flow, photos: PunchPhotos, key: string) => {
    const { storeId, deviceId } = deps.where();
    if (!deviceId) return;
    // An automatic resend goes on with the same wait.
    const since = f.view.at === 'wait' ? f.view.since : deps.now();
    const sending: Flow = { ...f, photos, key, view: { at: 'wait', label: 'checking', since } };
    setFlow(sending);
    const a = f.attempt;
    deps
      .punch(
        {
          storeId,
          kind: a.identify ? undefined : (a.kind ?? undefined),
          deviceId,
          platform: deps.platform(),
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
        },
        key,
      )
      .then(
        (data) => recorded(sending, data),
        (err: unknown) => refused(sending, err),
      );
  };

  const onCaptured = (photos: PunchPhotos) => {
    const f = state.flow;
    if (f) send(f, photos, deps.newKey());
  };

  const onReason = (reason: string) => {
    const f = state.flow;
    if (!f || f.view.at !== 'reason') return;
    const g: Flow = { ...f, attempt: { ...f.attempt, reason } };
    // Asked after the photos: the same photos again, now with the reason
    // (another request body, so another key).
    if (f.view.then === 'send' && f.photos) {
      send(g, f.photos, deps.newKey());
      return;
    }
    // Asked before the camera: a challenge that has gone stale while the
    // reason was typed is renewed first.
    if (deps.now() - g.attempt.challenge.at > CHALLENGE_FRESH_MS) {
      void again(g, g.attempt.challenge.steps.length > 0, null);
      return;
    }
    setFlow({ ...g, view: cameraView(g.attempt, g.round, null) });
  };

  const onRetry = () => {
    const f = state.flow;
    if (f) void again(f, f.attempt.identify, null);
  };

  const onResend = () => {
    const f = state.flow;
    if (f?.photos && f.key) send({ ...f, resent: 0 }, f.photos, f.key);
  };

  const onForSelf = () => {
    setFlow(null);
    deps.onAgain(false);
  };

  const onClose = () => {
    // Not while the punch is on its way (it may be recorded already), until
    // it has waited WAIT_CLOSABLE_MS (ATT-04).
    const view = state.flow?.view;
    if (view?.at === 'wait' && deps.now() - view.since < WAIT_CLOSABLE_MS) return;
    setFlow(null);
  };

  /** "Not <name>": take the colleague's punch back, then find the right face. */
  const undo = () => {
    const target = state.last;
    if (!target?.id || !target.forName || !target.undoUntil) return;
    deps.undo({ storeId: deps.where().storeId, punchId: target.id }).then(
      () => {
        deps.haptic('warning');
        setLast(null);
        setFlow(null);
        deps.refresh();
        deps.onAgain(true, 'attendance.punch.undone');
      },
      (err: unknown) => deps.failed(err),
    );
  };

  return {
    getState: (): PunchFlowState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start,
    undo,
    clearLast: () => setLast(null),
    onCaptured,
    onReason,
    onRetry,
    onResend,
    onForSelf,
    onClose,
  };
}

export type PunchFlowController = ReturnType<typeof punchFlow>;
