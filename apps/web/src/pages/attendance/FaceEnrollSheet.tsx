/**
 * Face enrollment (owner decisions 2026-11-06): face is the only way to
 * clock, so the reference is taken with care. Six photos, each taken by
 * the face tracker when the head is where the prompt asks: straight on,
 * each side (random order), chin up, chin down, straight on again. The
 * server checks them (one clear, sharp, well-lit real face of the same
 * person); a store manager then approves before the person can clock.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Sheet } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { jpegSrc } from '../../lib/attendanceCamera';
import { serverErrorKey } from '../../lib/errorText';
import { useErrToast } from '../../lib/errToast';
import { trpc } from '../../lib/trpc';
import { basicGuide, useAutoCapture, useCamera, useTracker, type Guide } from './faceCapture';
import { FaceOverlay } from './PunchCamera';

type Pose = 'front' | 'left' | 'right' | 'up' | 'down' | 'front2';
const POSES: readonly Pose[] = ['front', 'left', 'right', 'up', 'down', 'front2'];
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

const STRAIGHT_MAX = 0.12;
const TURN_MIN = 0.35;
/** Up and down: the head stays roughly straight sideways. */
const TILT_YAW_MAX = 0.25;
/** How far the pitch moves from the person's own straight-on value. */
const TILT_MIN = 0.1;
/** Up and down are taken anyway after this long (the turns are what liveness needs). */
const TILT_WAIT_MS = 6000;
/** Closer than for a punch: the reference should be sharp. */
const MIN_SIZE = 0.25;

function randomOrder(): Pose[] {
  const sides: Pose[] = Math.random() < 0.5 ? ['left', 'right'] : ['right', 'left'];
  return ['front', ...sides, 'up', 'down', 'front2'];
}

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
  const [round, setRound] = useState(0);
  const order = useMemo(() => randomOrder(), [round]); // eslint-disable-line react-hooks/exhaustive-deps
  const [shots, setShots] = useState<Partial<Record<Pose, string>>>({});
  const [guide, setGuide] = useState<Guide | null>(null);
  const [basePitch, setBasePitch] = useState<number | null>(null);
  const lastPitch = useRef<number | null>(null);
  const [problems, setProblems] = useState<{ pose: Pose; problem: Problem }[] | null>(null);

  const restart = () => {
    setRound((n) => n + 1);
    setShots({});
    setGuide(null);
    setBasePitch(null);
    setProblems(null);
  };
  useEffect(() => {
    if (open) restart();
  }, [open]);

  const step: Pose | 'review' = order.find((p) => !shots[p]) ?? 'review';
  const track = useTracker(open);
  const cam = useCamera(open && step !== 'review' && !problems ? 'user' : null);

  const enroll = trpc.attendance.faceEnroll.useMutation({
    onSuccess: () => {
      haptic('success');
      onDone();
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
        return;
      }
      errToast('attendance.errors.enrollFailed')(err);
    },
  });

  useAutoCapture({
    active:
      open &&
      step !== 'review' &&
      !problems &&
      cam.ready &&
      !cam.problem &&
      track.state === 'ready',
    video: cam.video,
    tracker: track.tracker,
    key: `${round}:${step}`,
    check: (r, since) => {
      const basic = basicGuide(r, MIN_SIZE);
      if (basic) return basic;
      const yaw = r.yaw!;
      if (r.pitch !== null) lastPitch.current = r.pitch;
      switch (step) {
        case 'front':
        case 'front2':
          return Math.abs(yaw) > STRAIGHT_MAX ? 'lookStraight' : null;
        case 'left':
          return yaw < TURN_MIN ? 'turnMore' : null;
        case 'right':
          return yaw > -TURN_MIN ? 'turnMore' : null;
        case 'up':
        case 'down': {
          if (Math.abs(yaw) > TILT_YAW_MAX) return 'lookStraight';
          if (since > TILT_WAIT_MS || basePitch === null || r.pitch === null) return null;
          const moved = r.pitch - basePitch;
          if (step === 'up') return moved > -TILT_MIN ? 'chinUp' : null;
          return moved < TILT_MIN ? 'chinDown' : null;
        }
        default:
          return null;
      }
    },
    onHeld: () => {
      if (step === 'review') return;
      const b64 = cam.grab();
      if (!b64) return;
      haptic('light');
      if (step === 'front') setBasePitch(lastPitch.current);
      setGuide(null);
      setShots((s) => ({ ...s, [step]: b64 }));
    },
    onGuide: setGuide,
  });

  const cannot = cam.problem !== null || track.state === 'failed';
  const title =
    step === 'review'
      ? i18n.t('attendance.enroll.reviewTitle')
      : i18n.t(`attendance.enroll.pose.${step}`);
  const arrow =
    step === 'left'
      ? '←'
      : step === 'right'
        ? '→'
        : step === 'up'
          ? '↑'
          : step === 'down'
            ? '↓'
            : '●';

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !enroll.isPending && onCancel()}
      title={title}
      description={
        step === 'review'
          ? i18n.t('attendance.enroll.reviewHint')
          : i18n.t(track.state === 'ready' ? 'attendance.enroll.hint' : 'attendance.live.preparing')
      }
    >
      <div className="flex flex-col gap-3 py-3">
        {problems ? (
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
        ) : cannot ? (
          <Banner tone="danger" title={i18n.t('attendance.face.cannotTitle')}>
            {i18n.t(
              cam.problem === 'denied'
                ? 'attendance.face.cannotDenied'
                : 'attendance.enroll.cannotBody',
            )}
          </Banner>
        ) : step !== 'review' ? (
          <div className="relative overflow-hidden rounded-[var(--r-card)] bg-black">
            <video
              ref={cam.setVideo}
              playsInline
              muted
              autoPlay
              onLoadedData={() => cam.setReady(true)}
              aria-label={title}
              className="aspect-[3/4] w-full -scale-x-100 object-cover"
            />
            <FaceOverlay
              title={title}
              arrow={arrow}
              loading={track.state === 'loading'}
              percent={track.percent}
              guide={track.state === 'ready' ? guide : null}
              progress={i18n.t('attendance.live.progress', {
                done: order.filter((p) => shots[p]).length,
                total: order.length,
              })}
            />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {order.map((p) => (
              <figure key={p} className="flex flex-col gap-1">
                <img
                  src={jpegSrc(shots[p]!)}
                  alt={i18n.t(`attendance.enroll.pose.${p}`)}
                  className="aspect-[3/4] w-full rounded-[var(--r-utility)] object-cover"
                />
                <figcaption className="text-center text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t(`attendance.enroll.pose.${p}`)}
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        {problems || step === 'review' ? (
          <div className="flex flex-col gap-2">
            {!problems ? (
              <Button
                block
                size="lg"
                loading={enroll.isPending}
                onClick={() =>
                  enroll.mutate({
                    storeId,
                    photos: {
                      front: shots.front!,
                      left: shots.left!,
                      right: shots.right!,
                      up: shots.up!,
                      down: shots.down!,
                      front2: shots.front2!,
                    },
                  })
                }
              >
                {i18n.t('attendance.enroll.submit')}
              </Button>
            ) : null}
            <Button
              block
              variant={problems ? 'primary' : 'ghost'}
              disabled={enroll.isPending}
              onClick={restart}
            >
              {i18n.t('attendance.enroll.again')}
            </Button>
          </div>
        ) : cannot ? (
          <Button block size="lg" variant="secondary" onClick={onCancel}>
            {i18n.t('common.cancel')}
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
