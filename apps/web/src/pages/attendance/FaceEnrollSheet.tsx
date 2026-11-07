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
import { Banner, Button, Sheet } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { serverErrorKey } from '../../lib/errorText';
import { useErrToast } from '../../lib/errToast';
import { trpc } from '../../lib/trpc';
import { useCamera, useTracker } from './faceCapture';
import {
  createRingSession,
  RING,
  TICKS,
  type EnrollShot,
  type RingGuide,
  type RingStage,
} from './faceRing';

type Pose = EnrollShot;
const POSES: readonly Pose[] = ['front', ...RING.map((r) => r.pose), 'front2'];
type Problem =
  | 'noFace'
  | 'manyFaces'
  | 'small'
  | 'dark'
  | 'bright'
  | 'blurry'
  | 'notFacing'
  | 'notTurned'
  | 'otherPerson'
  | 'spoof';
const PROBLEMS: readonly Problem[] = [
  'noFace',
  'manyFaces',
  'small',
  'dark',
  'bright',
  'blurry',
  'notFacing',
  'notTurned',
  'otherPerson',
  'spoof',
];

type Phase = Exclude<RingStage, 'over'> | 'sending' | 'done' | 'problems';

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
  const errToast = useErrToast();
  const [phase, setPhase] = useState<Phase>('position');
  const [lit, setLit] = useState<ReadonlySet<number>>(new Set());
  const [guide, setGuide] = useState<RingGuide | null>(null);
  const [slow, setSlow] = useState(false);
  const [problems, setProblems] = useState<{ pose: Pose; problem: Problem }[]>([]);
  const [round, setRound] = useState(0);
  // Kept out of state: the frame loop writes them.
  const shots = useRef<Partial<Record<Pose, string>>>({});

  const restart = () => {
    shots.current = {};
    setPhase('position');
    setLit(new Set());
    setGuide(null);
    setSlow(false);
    setProblems([]);
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
        const ctx = (err as { data?: { context?: { problems?: unknown } } }).data?.context;
        const list = typeof ctx?.problems === 'string' ? ctx.problems.split(',') : [];
        setProblems(
          list.flatMap((x) => {
            const [pose, problem] = x.split(':') as [Pose, Problem];
            return POSES.includes(pose) && PROBLEMS.includes(problem) ? [{ pose, problem }] : [];
          }),
        );
        setPhase('problems');
        return;
      }
      setPhase('problems');
      errToast('attendance.errors.enrollFailed')(err);
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
      const step = session.step(tracker.read(video), now);
      if (step.grab) {
        const b64 = grabRef.current();
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
          problems.length > 0 ? (
            <Banner tone="danger" title={i18n.t('attendance.enroll.rejectedTitle')}>
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
            </Banner>
          ) : null
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
            className="min-h-6 text-center text-old-body font-semibold text-[var(--c-fg)]"
            aria-live="polite"
          >
            {track.state === 'loading'
              ? i18n.t('attendance.live.preparingPercent', { percent: track.percent })
              : guide === 'center'
                ? i18n.t('attendance.enroll.center')
                : guide
                  ? i18n.t(`attendance.live.guide.${guide}`)
                  : phase === 'final'
                    ? i18n.t('attendance.live.guide.lookStraight')
                    : ''}
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
    <div className="relative aspect-square w-full max-w-[300px]">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden>
        {ticks}
      </svg>
      <div className="absolute inset-[13%] overflow-hidden rounded-full bg-black">
        {children}
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <span className="h-10 w-10 animate-spin rounded-full border-4 border-white/40 border-t-white" />
          </div>
        ) : null}
        {done ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--c-success)]">
            <svg viewBox="0 0 24 24" className="h-1/3 w-1/3" aria-hidden>
              <path
                d="M5 12.5l4.5 4.5L19 7.5"
                fill="none"
                stroke="white"
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
