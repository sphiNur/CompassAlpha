/**
 * Face enrollment (owner decisions 2026-11-06), in the manner of Face ID:
 *
 *   1. The face in the circle, looking straight: the first photo.
 *   2. A slow circle of the head. The ticks around the circle light where
 *      the head points, and a photo is kept in each of eight directions as
 *      the head passes it. The ring is full when all eight are in.
 *   3. Straight again: the last photo. Then it is sent by itself.
 *
 * Nothing is tapped: every photo is taken by the face tracker. The server
 * checks them (one clear, sharp, well-lit real face of the same person,
 * turned where it says); a store manager then approves before the person
 * can clock. The two side turns are required (they carry the liveness
 * check); if the tilts or diagonals do not come after a while, the ring
 * finishes without them.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Banner, Button, Sheet } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { serverErrorKey } from '../../lib/errorText';
import { useErrToast } from '../../lib/errToast';
import { trpc } from '../../lib/trpc';
import { basicGuide, useCamera, useTracker, type Guide } from './faceCapture';
import { headDirection, poseAt, RING, TICKS, ticksNear, ticksOf, type RingPose } from './faceRing';

type Pose = 'front' | RingPose | 'front2';
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

type Phase = 'position' | 'circle' | 'final' | 'sending' | 'done' | 'problems';

const STRAIGHT_MAX = 0.12;
/** Closer than for a punch: the reference should be sharp. */
const MIN_SIZE = 0.25;
/** How far off the middle of the frame the face may be. */
const CENTER_X = 0.18;
const CENTER_Y = 0.22;
/** Readings in a row (~120 ms apart) before a straight photo is taken. */
const HOLD = 3;
/** Ticks lit around where the head points right now (degrees each side). */
const POINTER = 9;
/** After this long in the circle, a hint to go slower and wider. */
const SLOW_HINT_MS = 12_000;
/** After this long, the circle finishes without the tilts it has not caught. */
const CIRCLE_GIVE_UP_MS = 30_000;

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
  const [guide, setGuide] = useState<Guide | 'center' | null>(null);
  const [slow, setSlow] = useState(false);
  const [problems, setProblems] = useState<{ pose: Pose; problem: Problem }[]>([]);
  const [round, setRound] = useState(0);
  // Kept out of state: the tracker loop reads and writes them every 120 ms.
  const shots = useRef<Partial<Record<Pose, string>>>({});
  const basePitch = useRef(0.5);

  const restart = () => {
    shots.current = {};
    basePitch.current = 0.5;
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
  const track = useTracker(open);
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

  // One tracker loop for the three capture phases.
  useEffect(() => {
    if (!capturing || !cam.ready || cam.problem || track.state !== 'ready') return;
    const tracker = track.tracker;
    const video = cam.video;
    if (!tracker || !video) return;
    const started = performance.now();
    let held = 0;
    let lastPose: RingPose | null = null;
    const timer = setInterval(() => {
      const r = tracker.read(video);
      const basic = basicGuide(r, MIN_SIZE);
      if (phase === 'position' || phase === 'final') {
        let next: Guide | 'center' | null = basic;
        if (!next && r.cx !== null && r.cy !== null) {
          if (Math.abs(r.cx - 0.5) > CENTER_X || Math.abs(r.cy - 0.5) > CENTER_Y) next = 'center';
        }
        if (!next && Math.abs(r.yaw!) > STRAIGHT_MAX) next = 'lookStraight';
        setGuide(next);
        held = next === null ? held + 1 : 0;
        if (held < HOLD) return;
        const b64 = cam.grab();
        if (!b64) return;
        clearInterval(timer);
        haptic('light');
        setGuide(null);
        if (phase === 'position') {
          shots.current.front = b64;
          basePitch.current = r.pitch ?? 0.5;
          setPhase('circle');
        } else {
          shots.current.front2 = b64;
          sendRef.current();
        }
        return;
      }
      // The circle.
      const elapsed = performance.now() - started;
      if (elapsed > SLOW_HINT_MS) setSlow(true);
      const have = shots.current;
      const finish = () => {
        clearInterval(timer);
        setLit(new Set(Array.from({ length: TICKS }, (_, i) => i)));
        haptic('success');
        setTimeout(() => setPhase('final'), 500);
      };
      if (elapsed > CIRCLE_GIVE_UP_MS && have.left && have.right) {
        finish();
        return;
      }
      if (basic || r.pitch === null) {
        setGuide(basic === 'closer' || basic === 'manyFaces' ? basic : null);
        lastPose = null;
        return;
      }
      setGuide(null);
      const d = headDirection(r.yaw!, r.pitch, basePitch.current);
      const pose = poseAt(d);
      const add = d.reach >= 0.7 ? ticksNear(d.angle, POINTER) : [];
      // The same direction twice in a row before its photo is kept.
      const keep = pose !== null && pose === lastPose && !have[pose];
      lastPose = pose;
      if (keep) {
        const b64 = cam.grab();
        if (b64) {
          have[pose] = b64;
          haptic('light');
          add.push(...ticksOf(pose));
        }
      }
      if (add.length) {
        setLit((prev) => {
          if (add.every((i) => prev.has(i))) return prev;
          const next = new Set(prev);
          for (const i of add) next.add(i);
          return next;
        });
      }
      if (RING.every((x) => have[x.pose])) finish();
    }, 120);
    return () => clearInterval(timer);
    // `cam.grab` and the refs are read fresh each tick; `round` restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, phase, cam.ready, cam.problem, cam.video, track.state, track.tracker, round]);

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
          transition: 'stroke 150ms',
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
