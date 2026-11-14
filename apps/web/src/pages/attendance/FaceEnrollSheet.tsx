/**
 * Face enrollment (owner decisions 2026-11-06), in the manner of Face ID
 * (continuous since 2026-11-07):
 *
 *   1. The face in the circle, looking straight: kept the moment it is
 *      steady, and the ring starts.
 *   2. A slow circle of the head. The ticks light wherever the head points,
 *      on every video frame; in each of eight directions the steadiest
 *      frame is kept in the background. Nothing to hold still for.
 *   3. Back to straight: the last frame. Then it is sent by itself.
 *
 * Nothing is tapped. The server checks the frames (one clear, sharp,
 * well-lit real face of the same person, turned where it says); a store
 * manager then approves before the person can clock. The two side turns
 * are required (they carry the liveness check); if the tilts or diagonals
 * do not come after a while, the ring finishes without them.
 * The ring's logic: faceRing.ts (createRingSession).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EnrollPose } from '@compass/contracts/schemas/faceEnroll';
import type { CatalogKey } from '@compass/i18n';
import { Banner, Button, Sheet, Spinner } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { useKeepInView } from '../../hooks/useKeepInView';
import { haptic } from '../../lib/telegram';
import { errorTextOf, serverErrorKey, type ErrorVars } from '../../lib/errorText';
import { trpc } from '../../lib/trpc';
import { readRefusals, type Refusal } from './enrollRefusals';
import { useCamera, useTracker } from './faceCapture';
import { createRingSession, TICKS, type RingGuide, type RingStage } from './faceRing';

type Phase = Exclude<RingStage, 'over'> | 'sending' | 'done' | 'problems';

/**
 * Enrollment frames are kept smaller than punch photos (2026-11-07): up to
 * ten go in one request over a slow link, and the face is still well over
 * the 112 px the recognizer works at.
 */
const ENROLL_SIDE = 560;

/** At most one tracker reading per this many ms (~20 a second). */
const FRAME_MS = 50;

export function FaceEnrollSheet({
  open,
  storeId,
  onCancel,
  onDone,
}: {
  open: boolean;
  storeId: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const i18n = useI18n();
  const [phase, setPhase] = useState<Phase>('position');
  const [lit, setLit] = useState<ReadonlySet<number>>(new Set());
  const [guide, setGuide] = useState<RingGuide | null>(null);
  const [slow, setSlow] = useState(false);
  const [problems, setProblems] = useState<Refusal[]>([]);
  const [failure, setFailure] = useState<{
    key: CatalogKey;
    vars: ErrorVars;
    code: string;
  } | null>(null);
  const [round, setRound] = useState(0);
  // Kept out of state: the frame loop writes them.
  const shots = useRef<Partial<Record<EnrollPose, string>>>({});

  const restart = () => {
    shots.current = {};
    setPhase('position');
    setLit(new Set());
    setGuide(null);
    setSlow(false);
    setProblems([]);
    setFailure(null);
    setRound((n) => n + 1);
  };
  useEffect(() => {
    if (open) restart();
  }, [open]);

  const capturing = open && (phase === 'position' || phase === 'circle' || phase === 'final');
  const track = useTracker(open, 'landmarker');
  const cam = useCamera(capturing ? 'user' : null);

  const enroll = trpc.attendance.faceEnroll.useMutation({
    onSuccess: () => {
      haptic('success');
      setPhase('done');
      setTimeout(onDone, 1500);
    },
    onError: (err) => {
      haptic('error');
      if (serverErrorKey(err) === 'attendance.errors.enrollRejected') {
        setProblems(readRefusals((err as { data?: { context?: unknown } }).data?.context));
        setPhase('problems');
        return;
      }
      // Not a refused photo: say why on the sheet itself, with a code to
      // send to support (2026-11-07: a toast alone left "failed, no reason").
      const text = errorTextOf(err, 'attendance.errors.enrollFailed');
      const e = err as { message?: unknown; data?: { httpStatus?: unknown; code?: unknown } };
      const code = [
        e.data?.httpStatus,
        e.data?.code,
        typeof e.message === 'string' ? e.message : '',
      ]
        .filter((x) => x !== undefined && x !== null && x !== '')
        .join(' ')
        .slice(0, 160);
      setFailure({ ...text, code });
      setPhase('problems');
    },
  });

  const send = () => {
    const s = shots.current;
    setPhase('sending');
    enroll.mutate({
      storeId,
      photos: {
        front: s.front!,
        left: s.left!,
        right: s.right!,
        front2: s.front2!,
        up: s.up,
        down: s.down,
        upleft: s.upleft,
        upright: s.upright,
        downleft: s.downleft,
        downright: s.downright,
      },
    });
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const grabRef = useRef(cam.grab);
  grabRef.current = cam.grab;

  // One loop, on the video's frames, for the whole ring.
  const loopOn = capturing && cam.ready && !cam.problem && track.state === 'ready';
  useEffect(() => {
    const tracker = track.tracker;
    const video = cam.video;
    if (!loopOn || !tracker || !video) return;
    const session = createRingSession();
    let raf = 0;
    let lastAt = 0;
    let shown: {
      stage: RingStage;
      guide: RingGuide | null;
      lit: ReadonlySet<number>;
      slow: boolean;
    } = { stage: 'position', guide: null, lit: new Set(), slow: false };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastAt < FRAME_MS) return;
      lastAt = now;
      // Only a new reading (review MWD-05: the tracker's worker may still be busy).
      const got = tracker.poll(video);
      if (!got) return;
      const step = session.step(got.reading, got.at);
      if (step.grab) {
        // The frame the reading is of, so the photo shows that pose.
        const b64 = grabRef.current(ENROLL_SIDE, got.frame);
        if (b64) {
          shots.current[step.grab] = b64;
          session.took(step.grab);
          if (step.grab === 'front' || step.grab === 'front2') haptic('light');
        }
      }
      const stage = session.stage;
      if (stage !== shown.stage) {
        if (stage === 'final') haptic('success');
        if (stage === 'over') {
          cancelAnimationFrame(raf);
          sendRef.current();
          return;
        }
        setPhase(stage);
      }
      if (step.guide !== shown.guide) setGuide(step.guide);
      if (step.lit !== shown.lit) setLit(step.lit);
      if (step.slow !== shown.slow) setSlow(step.slow);
      shown = { stage, guide: step.guide, lit: step.lit, slow: step.slow };
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `round` starts a new session.
  }, [loopOn, cam.video, track.tracker, round]);

  const cannot = capturing && (cam.problem !== null || track.state === 'failed');
  const title = i18n.t(
    phase === 'circle'
      ? 'attendance.enroll.phase.circle'
      : phase === 'final'
        ? 'attendance.enroll.phase.final'
        : phase === 'sending'
          ? 'attendance.enroll.phase.sending'
          : phase === 'done'
            ? 'attendance.enroll.phase.done'
            : phase === 'problems'
              ? 'attendance.enroll.rejectedTitle'
              : 'attendance.enroll.phase.position',
  );
  // The line under the ring says what to do; it comes back into view when
  // it changes (review ATT-06).
  const guideText =
    track.state === 'loading'
      ? i18n.t('attendance.live.preparingPercent', { percent: track.percent })
      : guide === 'center'
        ? i18n.t('attendance.enroll.center')
        : guide
          ? i18n.t(`attendance.live.guide.${guide}`)
          : phase === 'final'
            ? i18n.t('attendance.live.guide.lookStraight')
            : '';
  const guideLine = useRef<HTMLParagraphElement>(null);
  useKeepInView(guideLine, capturing ? `${guideText} ${cam.ready}` : null);

  const hint =
    phase === 'circle'
      ? i18n.t(slow ? 'attendance.enroll.slowHint' : 'attendance.enroll.circleHint')
      : phase === 'done'
        ? i18n.t('attendance.enroll.doneHint')
        : phase === 'position'
          ? i18n.t(track.state === 'ready' ? 'attendance.enroll.hint' : 'attendance.live.preparing')
          : '';

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && phase !== 'sending' && onCancel()}
      title={title}
      description={hint}
    >
      <div className="flex flex-col items-center gap-4 py-3">
        {cannot ? (
          <Banner tone="danger" title={i18n.t('attendance.face.cannotTitle')}>
            {i18n.t(
              cam.problem === 'denied'
                ? 'attendance.face.cannotDenied'
                : 'attendance.enroll.cannotBody',
            )}
          </Banner>
        ) : phase === 'problems' ? (
          failure ? (
            <Banner tone="danger" title={i18n.t('attendance.errors.enrollFailed')}>
              {failure.key !== 'attendance.errors.enrollFailed' ? (
                <p>{i18n.t(failure.key, failure.vars)}</p>
              ) : null}
              {failure.code ? (
                <p className="mt-1 break-all text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('attendance.enroll.errorCode', { code: failure.code })}
                </p>
              ) : null}
            </Banner>
          ) : (
            // Refused photos. Review ATT-27: the title shows even when no
            // line could be read; the sheet used to show nothing at all.
            <Banner tone="danger" title={i18n.t('attendance.enroll.rejectedTitle')}>
              {problems.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {problems.map((p, i) => (
                    <li key={i}>
                      {i18n.t('attendance.enroll.problemLine', {
                        pose: i18n.t(`attendance.enroll.pose.${p.pose}`),
                        problem: i18n.t(`attendance.enroll.problem.${p.problem}`),
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Banner>
          )
        ) : (
          <FaceRing
            lit={phase === 'final' || phase === 'sending' || phase === 'done' ? null : lit}
            done={phase === 'done'}
            busy={phase === 'sending'}
          >
            {capturing ? (
              <video
                ref={cam.setVideo}
                playsInline
                muted
                autoPlay
                onLoadedData={() => cam.setReady(true)}
                aria-label={title}
                className="h-full w-full -scale-x-100 object-cover"
              />
            ) : null}
          </FaceRing>
        )}

        {capturing && !cannot ? (
          <p
            ref={guideLine}
            className="min-h-6 text-center text-old-body font-semibold text-[var(--c-fg)]"
            aria-live="polite"
          >
            {guideText}
          </p>
        ) : null}

        {phase === 'problems' ? (
          <Button block size="lg" onClick={restart}>
            {i18n.t('attendance.enroll.again')}
          </Button>
        ) : cannot ? (
          <Button block size="lg" variant="secondary" onClick={onCancel}>
            {i18n.t('common.cancel')}
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * The round preview and the ticks around it. `lit` null: the whole ring
 * is done (green). `done`: a check mark over the preview.
 */
function FaceRing({
  lit,
  done,
  busy,
  children,
}: {
  lit: ReadonlySet<number> | null;
  done: boolean;
  busy: boolean;
  children?: ReactNode;
}) {
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const a = (i * 2 * Math.PI) / TICKS;
    const on = lit === null || lit.has(i);
    const outer = on ? 49 : 47.5;
    // Counter-clockwise from the right; screen y grows downwards.
    return (
      <line
        key={i}
        x1={50 + 44.5 * Math.cos(a)}
        y1={50 - 44.5 * Math.sin(a)}
        x2={50 + outer * Math.cos(a)}
        y2={50 - outer * Math.sin(a)}
        strokeWidth={1.4}
        strokeLinecap="round"
        style={{
          stroke: on ? 'var(--c-success)' : 'var(--c-divider)',
          transition: 'stroke 120ms',
        }}
      />
    );
  });
  return (
    <div
      // Review ATT-06: at most 0.45 of the screen's height, so on a phone
      // held sideways the line under the ring stays near the visible part.
      className="relative aspect-square w-full max-w-[min(300px,calc(var(--app-viewport-h,100dvh)*0.45))]"
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden>
        {ticks}
      </svg>
      <div
        // UI-8 exception: behind the camera picture, black in both themes.
        className="absolute inset-[13%] overflow-hidden rounded-full bg-black"
      >
        {children}
        {busy ? (
          <div
            // UI-8 exception: a dimmed camera picture with a white spinner
            // reads the same in both themes.
            className="absolute inset-0 flex items-center justify-center bg-black/40 text-white"
          >
            {/* Review ATT-20 (UI-15): the kit's Spinner, not a hand-drawn ring. */}
            <Spinner size={40} />
          </div>
        ) : null}
        {done ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--c-success)]">
            <svg viewBox="0 0 24 24" className="h-1/3 w-1/3" aria-hidden>
              <path
                d="M5 12.5l4.5 4.5L19 7.5"
                fill="none"
                // On the success fill, the inverse text colour: near-white
                // in the light theme, near-black in the dark one (white was
                // faint on the dark theme's lighter green).
                style={{ stroke: 'var(--c-fg-inverse)' }}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : null}
      </div>
    </div>
  );
}
