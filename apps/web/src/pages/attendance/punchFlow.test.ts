/**
 * Review TEST3-08 / ATT-25 (2026-11-10): the punch flow had no test beyond
 * punchOutcome's mapping. These drive the whole flow with a fake server,
 * clock and timers: the resends of a lost answer, the overtime reason
 * before and after the camera, a stale challenge, "Not <name>", and a
 * sheet closed while its punch is on the way (ATT-04).
 */
import { describe, expect, test } from 'bun:test';
import { ATTENDANCE_UNDO_WINDOW_MS } from '@compass/contracts/limits';
import {
  CHALLENGE_FRESH_MS,
  RESEND_WAITS_MS,
  UNDO_MARGIN_MS,
  WAIT_CLOSABLE_MS,
  punchFlow,
  type ChallengeAnswer,
  type ChallengeRequest,
  type Punched,
  type PunchRequest,
} from './punchFlow';
import type { PunchResult } from './PunchSheet';

/** A tRPC refusal as the client sees it: the key as message, placeholders in data.context. */
const refusal = (message: string, context?: Record<string, unknown>) =>
  Object.assign(new Error(message), { data: context ? { context } : {} });
/** An answer that never came. */
const lost = () => new TypeError('Failed to fetch (timed out)');

const PHOTOS = { face: 'face.jpg', left: 'left.jpg', right: 'right.jpg' };
const HERE = { lat: 41.3, lng: 69.24, accuracy: 12 };
const TURNS: ChallengeAnswer = { token: 'tok-1', steps: ['left', 'right'], acts: [] };

type Pending<T> = { resolve(v: T): void; reject(e: unknown): void };

/**
 * The flow with a fake server (challenges answer from a queue, punches and
 * undos wait to be answered), a clock, timers and a log of what the page
 * was told.
 */
function setup(opts: { deviceId?: string | null } = {}) {
  let clock = 1_000_000;
  let keys = 0;
  const timers: Array<{ at: number; fn: () => void; done: boolean }> = [];
  const log: string[] = [];
  const challengeQueue: Array<ChallengeAnswer | Error> = [];
  const challenges: ChallengeRequest[] = [];
  const punches: Array<{ input: PunchRequest; key: string } & Pending<Punched>> = [];
  const undos: Array<{ punchId: string } & Pending<unknown>> = [];
  let challengeGate: Promise<void> | null = null;

  const flow = punchFlow({
    where: () => ({
      storeId: 'store-1',
      deviceId: opts.deviceId === undefined ? 'phone-1' : opts.deviceId,
    }),
    async challenge(input) {
      challenges.push(input);
      if (challengeGate) await challengeGate;
      const next = challengeQueue.shift() ?? { token: `tok-${challenges.length}`, steps: [] };
      if (next instanceof Error) throw next;
      return next;
    },
    punch: (input, key) =>
      new Promise<Punched>((resolve, reject) => punches.push({ input, key, resolve, reject })),
    undo: ({ punchId }) =>
      new Promise((resolve, reject) => undos.push({ punchId, resolve, reject })),
    newKey: () => `key-${++keys}`,
    platform: () => 'ios',
    now: () => clock,
    later(fn, ms) {
      const timer = { at: clock + ms, fn, done: false };
      timers.push(timer);
      return () => void (timer.done = true);
    },
    haptic: (kind) => void log.push(`haptic ${kind}`),
    refresh: () => void log.push('refresh'),
    failed: (err, fallback) => void log.push(`toast ${(err as Error).message} | ${fallback}`),
    onConsent: () => void log.push('consent'),
    onEnroll: () => void log.push('enroll'),
    onAgain: (identify, notice) => void log.push(`again ${identify} ${notice ?? '-'}`),
  });

  /** Lets every pending promise callback run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return {
    flow,
    log,
    challenges,
    punches,
    undos,
    settle,
    view: () => flow.getState().flow?.view ?? null,
    answerChallenges: (...answers: Array<ChallengeAnswer | Error>) =>
      void challengeQueue.push(...answers),
    /** Holds every challenge request until the returned function is called. */
    holdChallenges() {
      let release = () => {};
      challengeGate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        challengeGate = null;
        release();
      };
    },
    /** Moves the clock and runs the timers that are due. */
    async wait(ms: number) {
      clock += ms;
      for (const timer of timers) {
        if (!timer.done && timer.at <= clock) {
          timer.done = true;
          timer.fn();
        }
      }
      await settle();
    },
    now: () => clock,
  };
}

/** A clock-in for oneself, photos taken, the punch on its way. */
async function punching(t: ReturnType<typeof setup>, answer: ChallengeAnswer = TURNS) {
  t.answerChallenges(answer);
  await t.flow.start(false, HERE, 'in');
  t.flow.onCaptured(PHOTOS);
  await t.settle();
  return t.punches.at(-1)!;
}

const RECORDED: Punched = { id: 'p1', kind: 'in', time: '09:02', forName: null, newDevice: false };

describe('punchFlow: a punch', () => {
  test('start asks for a challenge and opens the camera with its turns', async () => {
    const t = setup();
    t.answerChallenges({ ...TURNS, acts: ['blink'] });
    const started = t.flow.start(false, HERE, 'in');
    expect(t.flow.getState().preparing).toBe(true);
    await started;
    expect(t.flow.getState().preparing).toBe(false);
    expect(t.challenges).toEqual([{ storeId: 'store-1', deviceId: 'phone-1', location: HERE }]);
    expect(t.view()).toEqual({
      at: 'camera',
      round: 1,
      turns: ['left', 'right'],
      acts: ['blink'],
      notice: null,
    });
  });

  test('a challenge that cannot be had is a toast, and no sheet', async () => {
    const t = setup();
    t.answerChallenges(refusal('attendance.errors.notEnabled'));
    await t.flow.start(false, HERE, 'in');
    expect(t.log).toEqual(['toast attendance.errors.notEnabled | attendance.errors.punchFailed']);
    expect(t.flow.getState()).toMatchObject({ flow: null, preparing: false });
  });

  test('the photos go with a new key, the kind asked for and the challenge', async () => {
    const t = setup();
    const sent = await punching(t);
    expect(sent.key).toBe('key-1');
    expect(sent.input).toEqual({
      storeId: 'store-1',
      kind: 'in',
      deviceId: 'phone-1',
      platform: 'ios',
      location: HERE,
      photos: { face: 'face.jpg' },
      liveness: { token: 'tok-1', left: 'left.jpg', right: 'right.jpg' },
    });
    expect(t.view()).toEqual({ at: 'wait', label: 'checking', since: t.now() });
  });

  test("a colleague's punch leaves the kind to the server", async () => {
    const t = setup();
    t.answerChallenges(TURNS);
    await t.flow.start(true, null, null);
    t.flow.onCaptured(PHOTOS);
    expect(t.punches[0]!.input).toMatchObject({ kind: undefined, identify: true, location: null });
  });

  test('without the phone id nothing is sent', async () => {
    const t = setup({ deviceId: null });
    t.answerChallenges(TURNS);
    await t.flow.start(false, HERE, 'in');
    t.flow.onCaptured(PHOTOS);
    expect(t.punches).toHaveLength(0);
  });

  test('recorded: done, and the page re-reads what is recorded', async () => {
    const t = setup();
    const sent = await punching(t);
    sent.resolve(RECORDED);
    await t.settle();
    const result: PunchResult = {
      id: 'p1',
      kind: 'in',
      time: '09:02',
      forName: null,
      flagged: false,
      already: false,
      undoUntil: null,
    };
    expect(t.view()).toEqual({ at: 'done', result });
    expect(t.flow.getState().last).toEqual(result);
    expect(t.log).toEqual(['haptic success', 'refresh']);
  });

  test('listeners hear every change until they unsubscribe', async () => {
    const t = setup();
    let heard = 0;
    const stop = t.flow.subscribe(() => heard++);
    await t.flow.start(false, HERE, 'in');
    expect(heard).toBeGreaterThan(0);
    stop();
    const before = heard;
    t.flow.onClose();
    expect(heard).toBe(before);
  });
});

describe('punchFlow: a lost answer (ATT-03)', () => {
  test('the same photos go again with the same key, after 1.5 s and 4 s', async () => {
    const t = setup();
    const first = await punching(t);
    const since = t.now();
    first.reject(lost());
    await t.settle();
    expect(t.punches).toHaveLength(1);
    await t.wait(RESEND_WAITS_MS[0]! - 1);
    expect(t.punches).toHaveLength(1);
    await t.wait(1);
    expect(t.punches).toHaveLength(2);
    t.punches[1]!.reject(lost());
    await t.settle();
    await t.wait(RESEND_WAITS_MS[1]!);
    expect(t.punches).toHaveLength(3);
    expect(t.punches.map((p) => p.key)).toEqual(['key-1', 'key-1', 'key-1']);
    // One wait on screen: the resends keep its start.
    expect(t.view()).toEqual({ at: 'wait', label: 'checking', since });
  });

  test('after the resends: "it may have got through", and a resend button', async () => {
    const t = setup();
    (await punching(t)).reject(lost());
    await t.settle();
    for (const wait of RESEND_WAITS_MS) {
      await t.wait(wait);
      t.punches.at(-1)!.reject(lost());
      await t.settle();
    }
    expect(t.view()).toEqual({
      at: 'failed',
      title: 'attendance.punch.netFailed',
      vars: {},
      body: 'attendance.punch.netFailedBody',
      action: 'resend',
    });
    expect(t.log).toEqual(['haptic error', 'refresh']);
    // The button sends the same photos with the same key, and resends again.
    t.flow.onResend();
    expect(t.punches.at(-1)!.key).toBe('key-1');
    t.punches.at(-1)!.reject(lost());
    await t.settle();
    await t.wait(RESEND_WAITS_MS[0]!);
    expect(t.punches).toHaveLength(RESEND_WAITS_MS.length + 3);
  });

  test('a resend due after the sheet was closed is not sent (ATT-04)', async () => {
    const t = setup();
    const sent = await punching(t);
    // A slow answer that is then lost: the sheet can be closed by now.
    await t.wait(WAIT_CLOSABLE_MS);
    sent.reject(lost());
    await t.settle();
    t.flow.onClose();
    await t.wait(RESEND_WAITS_MS[0]!);
    expect(t.punches).toHaveLength(1);
  });
});

describe('punchFlow: closing the sheet (ATT-04)', () => {
  test('not while the punch is on its way, until the wait has lasted 30 s', async () => {
    const t = setup();
    await punching(t);
    await t.wait(WAIT_CLOSABLE_MS - 1);
    t.flow.onClose();
    expect(t.flow.getState().flow).not.toBeNull();
    await t.wait(1);
    t.flow.onClose();
    expect(t.flow.getState().flow).toBeNull();
  });

  test('an answer after closing updates the page, not the sheet', async () => {
    const t = setup();
    const sent = await punching(t);
    await t.wait(WAIT_CLOSABLE_MS);
    t.flow.onClose();
    sent.resolve(RECORDED);
    await t.settle();
    expect(t.flow.getState().flow).toBeNull();
    expect(t.flow.getState().last?.id).toBe('p1');
  });

  test('a refusal after closing only re-reads the page; nothing goes again', async () => {
    const t = setup();
    const sent = await punching(t);
    await t.wait(WAIT_CLOSABLE_MS);
    t.flow.onClose();
    sent.reject(refusal('attendance.errors.livenessNeeded'));
    await t.settle();
    expect(t.log).toEqual(['refresh']);
    expect(t.challenges).toHaveLength(1);
  });

  test('a fresh challenge that comes after closing leaves it closed', async () => {
    const t = setup();
    t.answerChallenges(TURNS);
    await t.flow.start(false, HERE, 'in');
    const release = t.holdChallenges();
    t.flow.onRetry();
    expect(t.view()).toMatchObject({ at: 'wait', label: 'preparing' });
    await t.wait(WAIT_CLOSABLE_MS);
    t.flow.onClose();
    release();
    await t.settle();
    expect(t.flow.getState().flow).toBeNull();
  });
});

describe('punchFlow: what the server asks for next', () => {
  test('the turns: a forced challenge and the camera again, round 2', async () => {
    const t = setup();
    (await punching(t, { token: 'tok-1', steps: [] })).reject(
      refusal('attendance.errors.livenessNeeded'),
    );
    await t.settle();
    expect(t.challenges.at(-1)).toMatchObject({ force: true });
    expect(t.view()).toMatchObject({ at: 'camera', round: 2, notice: 'attendance.punch.oneMore' });
    expect(t.log).toContain('haptic warning');
    // The next photos are a new punch: a new key.
    t.flow.onCaptured(PHOTOS);
    expect(t.punches.at(-1)!.key).toBe('key-2');
  });

  test('an expired challenge: a new one, forced only if this one had turns', async () => {
    for (const [steps, force] of [
      [[], undefined],
      [['left'], true],
    ] as const) {
      const t = setup();
      (await punching(t, { token: 'tok-1', steps: [...steps] })).reject(
        refusal('attendance.errors.livenessExpired'),
      );
      await t.settle();
      expect(t.challenges.at(-1)!.force).toBe(force);
      expect(t.view()).toMatchObject({ at: 'camera', notice: 'attendance.punch.restart' });
    }
  });

  test('a fresh challenge that fails: its error, and another try', async () => {
    const t = setup();
    const sent = await punching(t);
    t.answerChallenges(refusal('attendance.errors.notEnabled'));
    sent.reject(refusal('attendance.errors.livenessNeeded'));
    await t.settle();
    expect(t.view()).toEqual({
      at: 'failed',
      title: 'attendance.errors.notEnabled',
      vars: {},
      body: null,
      action: 'retry',
    });
  });

  test('a refused face: why, what to do, and another face check', async () => {
    const t = setup();
    (await punching(t)).reject(refusal('attendance.errors.notRecognized'));
    await t.settle();
    expect(t.view()).toEqual({
      at: 'failed',
      title: 'attendance.errors.notRecognized',
      vars: {},
      body: 'attendance.punch.notRecognizedHint',
      action: 'retry',
    });
    t.flow.onRetry();
    await t.settle();
    // Another check for oneself is not forced; a colleague's always is.
    expect(t.challenges.at(-1)!.force).toBeUndefined();
    expect(t.view()).toMatchObject({ at: 'camera', round: 2 });
  });

  test("the phone's own person in a colleague's check: their own punch instead", async () => {
    const t = setup();
    t.answerChallenges(TURNS);
    await t.flow.start(true, null, null);
    t.flow.onCaptured(PHOTOS);
    t.punches[0]!.reject(refusal('attendance.errors.identifyIsOwner'));
    await t.settle();
    expect(t.view()).toMatchObject({ at: 'failed', action: 'forSelf' });
    t.flow.onForSelf();
    expect(t.flow.getState().flow).toBeNull();
    expect(t.log.at(-1)).toBe('again false -');
  });

  test('no consent or no face yet: the sheet closes and the page asks', async () => {
    const t = setup();
    (await punching(t)).reject(refusal('attendance.errors.consentRequired'));
    await t.settle();
    expect(t.flow.getState().flow).toBeNull();
    expect(t.log).toEqual(['consent']);

    const u = setup();
    (await punching(u)).reject(refusal('attendance.errors.faceNotEnrolled'));
    await u.settle();
    expect(u.flow.getState().flow).toBeNull();
    expect(u.log).toEqual(['refresh', 'enroll']);
  });

  test('recorded before: shown as done, not as an error', async () => {
    const t = setup();
    (await punching(t)).reject(
      refusal('attendance.errors.alreadyClockedIn', { lastKind: 'in', time: '09:02' }),
    );
    await t.settle();
    expect(t.view()).toMatchObject({ at: 'done', result: { already: true, time: '09:02' } });
    expect(t.flow.getState().last).toMatchObject({ already: true, undoUntil: null });
    expect(t.log).toEqual(['haptic success', 'refresh']);
  });

  test('anything else stops, with its placeholders and no next try', async () => {
    const t = setup();
    (await punching(t)).reject(refusal('attendance.errors.outsideArea', { distance: 900 }));
    await t.settle();
    expect(t.view()).toEqual({
      at: 'failed',
      title: 'attendance.errors.outsideArea',
      vars: { distance: 900 },
      body: null,
      action: null,
    });
    expect(t.log).toEqual(['haptic error', 'refresh']);
  });
});

describe('punchFlow: the overtime reason', () => {
  test('asked before the camera when the challenge says so', async () => {
    const t = setup();
    t.answerChallenges({ ...TURNS, overtimeMinutes: 45 });
    await t.flow.start(false, HERE, 'out');
    expect(t.view()).toEqual({ at: 'reason', minutes: 45, name: null, then: 'camera' });
    t.flow.onReason('Inventory');
    expect(t.view()).toMatchObject({ at: 'camera', round: 1 });
    t.flow.onCaptured(PHOTOS);
    expect(t.punches[0]!.input.overtimeReason).toBe('Inventory');
  });

  test('a challenge gone stale while the reason was typed is renewed first', async () => {
    const t = setup();
    t.answerChallenges({ ...TURNS, overtimeMinutes: 45 });
    await t.flow.start(false, HERE, 'out');
    await t.wait(CHALLENGE_FRESH_MS + 1);
    t.flow.onReason('Inventory');
    await t.settle();
    expect(t.challenges).toHaveLength(2);
    // It had turns, so the new one keeps them.
    expect(t.challenges[1]!.force).toBe(true);
    expect(t.view()).toMatchObject({ at: 'camera', round: 2 });
    t.flow.onCaptured(PHOTOS);
    expect(t.punches[0]!.input.overtimeReason).toBe('Inventory');
  });

  test("a colleague's, once their face is known: the same photos with a new key", async () => {
    const t = setup();
    t.answerChallenges(TURNS);
    await t.flow.start(true, null, null);
    t.flow.onCaptured(PHOTOS);
    t.punches[0]!.reject(
      refusal('attendance.errors.overtimeReasonRequired', { minutes: 40, name: 'Bob' }),
    );
    await t.settle();
    expect(t.view()).toEqual({ at: 'reason', minutes: 40, name: 'Bob', then: 'send' });
    t.flow.onReason('Delivery came late');
    const again = t.punches[1]!;
    expect(again.key).toBe('key-2');
    expect(again.input.photos).toEqual({ face: 'face.jpg' });
    expect(again.input.overtimeReason).toBe('Delivery came late');
    expect(t.challenges).toHaveLength(1);
  });

  test('a reason given with no reason asked is ignored', async () => {
    const t = setup();
    await punching(t);
    t.flow.onReason('typed late');
    expect(t.punches).toHaveLength(1);
  });

  test('a stay-in that says no overtime opens the camera straight away', async () => {
    const t = setup();
    t.answerChallenges({ ...TURNS, overtimeMinutes: 0 });
    await t.flow.start(false, HERE, 'out');
    expect(t.view()).toMatchObject({ at: 'camera' });
    // A colleague's challenge never asks first: only their face says whose it is.
    const u = setup();
    u.answerChallenges({ ...TURNS, overtimeMinutes: 45 });
    await u.flow.start(true, null, null);
    expect(u.view()).toMatchObject({ at: 'camera' });
  });
});

describe('punchFlow: "Not <name>"', () => {
  async function colleagueRecorded() {
    const t = setup();
    t.answerChallenges(TURNS);
    await t.flow.start(true, null, null);
    t.flow.onCaptured(PHOTOS);
    t.punches[0]!.resolve({ ...RECORDED, forName: 'Bob' });
    await t.settle();
    return t;
  }

  test("a colleague's punch can be taken back until shortly before the server's window ends", async () => {
    const t = await colleagueRecorded();
    const window = ATTENDANCE_UNDO_WINDOW_MS - UNDO_MARGIN_MS;
    expect(t.flow.getState().last?.undoUntil).toBe(t.now() + window);
    await t.wait(window - 1);
    expect(t.flow.getState().last?.undoUntil).not.toBeNull();
    await t.wait(1);
    expect(t.flow.getState().last).toMatchObject({ id: 'p1', undoUntil: null });
  });

  test('taken back: the sheet closes and the face check starts again for a colleague', async () => {
    const t = await colleagueRecorded();
    t.flow.undo();
    expect(t.undos.map((u) => u.punchId)).toEqual(['p1']);
    t.undos[0]!.resolve(undefined);
    await t.settle();
    expect(t.flow.getState()).toMatchObject({ flow: null, last: null });
    expect(t.log.slice(-3)).toEqual([
      'haptic warning',
      'refresh',
      'again true attendance.punch.undone',
    ]);
  });

  test('an undo the server refuses is a toast; the punch stays', async () => {
    const t = await colleagueRecorded();
    t.flow.undo();
    t.undos[0]!.reject(refusal('attendance.errors.undoTooLate'));
    await t.settle();
    // Review ATT-17: a refusal with no reason of its own is not "could not
    // clock in"; the undo falls back to the generic sentence.
    expect(t.log.at(-1)).toBe('toast attendance.errors.undoTooLate | common.errors.actionFailed');
    expect(t.flow.getState().last?.id).toBe('p1');
  });

  test('not for oneself, and not once the time is up', async () => {
    const t = setup();
    (await punching(t)).resolve(RECORDED);
    await t.settle();
    t.flow.undo();
    expect(t.undos).toHaveLength(0);

    const u = await colleagueRecorded();
    await u.wait(ATTENDANCE_UNDO_WINDOW_MS);
    u.flow.undo();
    expect(u.undos).toHaveLength(0);
  });

  test('a new punch clears the last result and its timer', async () => {
    const t = await colleagueRecorded();
    await t.flow.start(false, HERE, 'in');
    expect(t.flow.getState().last).toBeNull();
    await t.wait(ATTENDANCE_UNDO_WINDOW_MS);
    expect(t.flow.getState().last).toBeNull();
  });
});
