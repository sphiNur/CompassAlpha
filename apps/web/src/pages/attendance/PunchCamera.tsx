/**
 * The clock-in camera (2026-11-05): the face, from the front camera. The
 * rear-camera photo of the place was removed (owner, 2026-11-07).
 *
 * Liveness (2026-11-06): with `turns`, each head turn after the straight
 * frame, in the order the server chose. The server checks the frames; the
 * phone only guides.
 *
 * Blink and open mouth (owner, 2026-11-07): every punch, after the
 * straight frame, a blink and an open mouth in the server's order; the
 * frame is taken at the moment (faceActs.ts).
 *
 * Face only (owner, 2026-11-06): the face frames are taken by the face
 * tracker when the head is where the prompt asks; there is no shutter for
 * them and no system camera (which could pick a photo from the gallery).
 * A phone whose camera or tracker cannot run cannot clock by itself: a
 * colleague's phone or the manager's manual punch then.
 *
 * Straight on (owner, 2026-11-07): nobody looks at the photos before they
 * go. The last frame hands them over and the camera goes off; the sheet
 * around this (PunchSheet) shows the check and its result. Each try mounts
 * this afresh, so nothing of the last one (a half-done blink) carries over.
 */
import { useRef, useState } from 'react';
import { Banner, Button } from '@compass/ui';
import type { CatalogKey } from '@compass/i18n';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { createActWatcher, type Act } from './faceActs';
import { useAutoCapture, useCamera, useFrameLoop, useTracker } from './faceCapture';
import { basicGuide, type Guide } from './faceGuide';

export type Turn = 'left' | 'right';
export type PunchPhotos = {
  face: string;
  left?: string;
  right?: string;
  blink?: string;
  mouth?: string;
};
type Shot = 'face' | Turn | Act;

/** Where the tracker takes the frame (the server accepts turns from 0.2, straight up to 0.2). */
const STRAIGHT_MAX = 0.12;
const TURN_MIN = 0.35;
/** The face's width as a share of the frame (the server wants 0.18 for enrollment). */
const MIN_SIZE = 0.2;

export function PunchCamera({
  turns,
  acts,
  identifying,
  notice,
  onCaptured,
  onCancel,
}: {
  /** The liveness turn order from the server; empty = no turns. */
  turns: readonly Turn[];
  /** The blink and open mouth, in the server's order; none from an old server. */
  acts: readonly Act[];
  /** A colleague clocks on this phone: the face says who. */
  identifying: boolean;
  /** Why this try: the server asked for the turns, the last one ran out. */
  notice: CatalogKey | null;
  /** The last frame is in: the photos, once. */
  onCaptured: (photos: PunchPhotos) => void;
  onCancel: () => void;
}) {
  const i18n = useI18n();
  const faceShots: Shot[] = ['face', ...acts, ...turns];
  const [step, setStep] = useState<Shot>('face');
  const [shots, setShots] = useState<Partial<Record<Shot, string>>>({});
  const [guide, setGuide] = useState<Guide | null>(null);
  // Handed over: the camera goes off at once, nothing more is taken.
  const [finished, setFinished] = useState(false);
  // The blink's frame is taken while the eyes are shut, kept once they open.
  const frames = useRef<Partial<Record<Act, string>>>({});

  const track = useTracker(true);
  const cam = useCamera(finished ? null : 'user');
  const isAct = step === 'blink' || step === 'mouth';
  const running = !finished && cam.ready && !cam.problem && track.state === 'ready';

  const keep = (b64: string) => {
    if (finished) return;
    haptic('light');
    const next = { ...shots, [step]: b64 };
    setShots(next);
    setGuide(null);
    const missing = faceShots.find((s) => !next[s]);
    if (missing) {
      setStep(missing);
      return;
    }
    setFinished(true);
    onCaptured({
      face: next.face!,
      left: next.left,
      right: next.right,
      blink: next.blink,
      mouth: next.mouth,
    });
  };
  const shoot = () => {
    const b64 = cam.grab();
    if (b64) keep(b64);
  };

  // The blink or the open mouth: its own watcher for each step.
  const watcher = useRef<{ step: Shot; w: ReturnType<typeof createActWatcher> } | null>(null);
  useFrameLoop({
    active: running && isAct,
    video: cam.video,
    tracker: track.tracker,
    key: step,
    onReading: (r, now) => {
      if (step !== 'blink' && step !== 'mouth') return true;
      if (watcher.current?.step !== step) watcher.current = { step, w: createActWatcher(step) };
      const w = watcher.current.w;
      const out = w.step(r, now);
      setGuide(out.guide);
      if (out.grab) {
        const b64 = cam.grab();
        if (b64) {
          w.took();
          frames.current[step] = b64;
        }
      }
      if (!w.done) return;
      watcher.current = null;
      keep(frames.current[step]!);
      return true;
    },
  });

  useAutoCapture({
    active: running && !isAct,
    video: cam.video,
    tracker: track.tracker,
    key: step,
    check: (r) => {
      const basic = basicGuide(r, MIN_SIZE);
      if (basic) return basic;
      const yaw = r.yaw!;
      if (step === 'face' && Math.abs(yaw) > STRAIGHT_MAX) return 'lookStraight';
      if (step === 'left' && yaw < TURN_MIN) return 'turnMore';
      if (step === 'right' && yaw > -TURN_MIN) return 'turnMore';
      return null;
    },
    onHeld: shoot,
    onGuide: setGuide,
  });

  // This phone cannot take a face frame: no clocking on it by itself.
  const cannot = cam.problem !== null || track.state === 'failed';
  const title = i18n.t(
    step === 'blink'
      ? 'attendance.live.blinkTitle'
      : step === 'mouth'
        ? 'attendance.live.mouthTitle'
        : step === 'left'
          ? 'attendance.live.turnLeft'
          : step === 'right'
            ? 'attendance.live.turnRight'
            : 'attendance.live.lookTitle',
  );
  const hint = i18n.t(
    track.state === 'ready'
      ? 'attendance.live.autoHint'
      : track.slow
        ? 'attendance.live.slow'
        : 'attendance.live.preparing',
  );

  return (
    <div className="flex flex-col gap-3">
      {notice ? <Banner tone="info" title={i18n.t(notice)} /> : null}
      {identifying ? (
        <p className="text-old-label font-semibold text-[var(--c-fg)]">
          {i18n.t('attendance.borrow.identifyHint')}
        </p>
      ) : null}
      {cannot ? (
        <>
          <Banner tone="danger" title={i18n.t('attendance.face.cannotTitle')}>
            {i18n.t(
              cam.problem === 'denied'
                ? 'attendance.face.cannotDenied'
                : 'attendance.face.cannotBody',
            )}
          </Banner>
          <Button block size="lg" variant="secondary" onClick={onCancel}>
            {i18n.t('common.cancel')}
          </Button>
        </>
      ) : (
        <>
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
              arrow={step === 'left' ? '←' : step === 'right' ? '→' : '●'}
              loading={track.state === 'loading'}
              percent={track.percent}
              guide={track.state === 'ready' ? guide : null}
              progress={i18n.t('attendance.live.progress', {
                done: faceShots.filter((s) => shots[s]).length,
                total: faceShots.length,
              })}
            />
          </div>
          <p className="text-old-label text-[var(--c-fg-muted)]">{hint}</p>
        </>
      )}
    </div>
  );
}

/** The prompt over the front camera: what to do, the tracker's download, progress. */
export function FaceOverlay({
  title,
  arrow,
  loading,
  percent,
  guide,
  progress,
}: {
  title: string;
  arrow: string;
  loading: boolean;
  percent: number;
  guide: Guide | null;
  progress: string;
}) {
  const i18n = useI18n();
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-3 pb-3 pt-8 text-center text-white">
      <span className="text-old-h3 font-semibold">
        {arrow} {title}
      </span>
      {loading ? (
        <span className="flex w-full max-w-60 flex-col items-center gap-1">
          <span className="text-old-label">
            {i18n.t('attendance.live.preparingPercent', { percent })}
          </span>
          <span
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/30"
            role="progressbar"
            aria-label={i18n.t('attendance.live.preparingPercent', { percent })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span
              className="block h-full rounded-full bg-white transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </span>
        </span>
      ) : null}
      {guide ? (
        <span className="text-old-label">{i18n.t(`attendance.live.guide.${guide}`)}</span>
      ) : null}
      <span className="text-old-label opacity-80" aria-live="polite">
        {progress}
      </span>
    </div>
  );
}
