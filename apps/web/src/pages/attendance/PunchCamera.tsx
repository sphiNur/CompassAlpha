/**
 * The clock-in photos (2026-11-05): the face (front camera), then a look
 * at it before the punch is sent. The rear-camera photo of the place was
 * removed (owner, 2026-11-07).
 *
 * Liveness (2026-11-06): with `turns`, the face step becomes three front
 * camera frames: straight on, then each head turn in the order the server
 * chose. The server checks the frames; the phone only guides.
 *
 * Face only (owner, 2026-11-06): the face frames are taken by the face
 * tracker when the head is where the prompt asks; there is no shutter for
 * them and no system camera (which could pick a photo from the gallery).
 * A phone whose camera or tracker cannot run cannot clock by itself: a
 * colleague's phone or the manager's manual punch then.
 */
import { useEffect, useState } from 'react';
import { Banner, Button, Sheet } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { jpegSrc, type Facing } from '../../lib/attendanceCamera';
import { basicGuide, useAutoCapture, useCamera, useTracker, type Guide } from './faceCapture';

export type Turn = 'left' | 'right';
export type PunchPhotos = { face: string; left?: string; right?: string };
type Shot = 'face' | Turn;
type Step = Shot | 'review';

/** Where the tracker takes the frame (the server accepts turns from 0.2, straight up to 0.2). */
const STRAIGHT_MAX = 0.12;
const TURN_MIN = 0.35;
/** The face's width as a share of the frame (the server wants 0.18 for enrollment). */
const MIN_SIZE = 0.2;

export function PunchCamera({
  open,
  kind,
  turns: askedTurns,
  identifying,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** null: a colleague found by their face; the server knows their next punch. */
  kind: 'in' | 'out' | null;
  /** The liveness turn order from the server; null or empty = no turns. */
  turns: Turn[] | null;
  /** A colleague clocks on this phone: the face says who. */
  identifying?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (photos: PunchPhotos) => void;
}) {
  const i18n = useI18n();
  const turns = askedTurns && askedTurns.length > 0 ? askedTurns : [];
  const faceShots: Shot[] = ['face', ...turns];
  const sequence: Shot[] = faceShots;
  const [step, setStep] = useState<Step>('face');
  const [shots, setShots] = useState<Partial<Record<Shot, string>>>({});
  const [guide, setGuide] = useState<Guide | null>(null);

  // Start over each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setStep('face');
    setShots({});
    setGuide(null);
  }, [open]);

  const track = useTracker(open);
  // The front camera stays on through the face and turn frames.
  const facing: Facing | null = !open || step === 'review' ? null : 'user';
  const cam = useCamera(facing);
  const front = step === 'face' || step === 'left' || step === 'right';

  const keep = (b64: string) => {
    haptic('light');
    if (step === 'review') return;
    const next = { ...shots, [step]: b64 };
    setShots(next);
    setGuide(null);
    setStep(sequence.find((s) => !next[s]) ?? 'review');
  };
  const shoot = () => {
    const b64 = cam.grab();
    if (b64) keep(b64);
  };

  useAutoCapture({
    active: open && front && cam.ready && !cam.problem && track.state === 'ready',
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

  /** Retaking any face frame retakes all of them, in order. */
  const retake = () => {
    setShots({});
    setStep('face');
  };

  // This phone cannot take a face frame: no clocking on it by itself.
  const cannot = front && (cam.problem !== null || track.state === 'failed');
  const title =
    step === 'review'
      ? i18n.t('attendance.photo.reviewTitle')
      : step === 'left'
        ? i18n.t('attendance.live.turnLeft')
        : step === 'right'
          ? i18n.t('attendance.live.turnRight')
          : i18n.t('attendance.live.lookTitle');
  const hint =
    step === 'review'
      ? i18n.t('attendance.photo.reviewHintFace')
      : i18n.t(
          track.state === 'ready'
            ? 'attendance.live.autoHint'
            : track.slow
              ? 'attendance.live.slow'
              : 'attendance.live.preparing',
        );

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !busy && onCancel()}
      title={title}
      description={hint}
    >
      <div className="flex flex-col gap-3 py-3">
        {identifying ? (
          <p className="text-old-label font-semibold text-[var(--c-fg)]">
            {i18n.t('attendance.borrow.identifyHint')}
          </p>
        ) : null}
        {cannot ? (
          <Banner tone="danger" title={i18n.t('attendance.face.cannotTitle')}>
            {i18n.t(
              cam.problem === 'denied'
                ? 'attendance.face.cannotDenied'
                : 'attendance.face.cannotBody',
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
              className={`aspect-[3/4] w-full object-cover ${front ? '-scale-x-100' : ''}`}
            />
            {front ? (
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
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {sequence.map((which) => {
              const src = shots[which];
              return (
                <figure key={which} className="flex flex-col gap-1">
                  {src ? (
                    <img
                      src={jpegSrc(src)}
                      alt={i18n.t(`attendance.photo.${which}`)}
                      className="aspect-[3/4] w-full rounded-[var(--r-card)] object-cover"
                    />
                  ) : null}
                  <figcaption className="flex items-center justify-between text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t(`attendance.photo.${which}`)}
                    <Button variant="ghost" size="sm" disabled={busy} onClick={retake}>
                      {i18n.t('attendance.photo.retake')}
                    </Button>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}

        {step === 'review' ? (
          <Button
            block
            size="lg"
            loading={busy}
            disabled={sequence.some((s) => !shots[s])}
            onClick={() =>
              shots.face &&
              onConfirm({
                face: shots.face,
                left: shots.left,
                right: shots.right,
              })
            }
          >
            {i18n.t(
              kind === null
                ? 'attendance.borrow.identifySend'
                : kind === 'in'
                  ? 'attendance.clock.in'
                  : 'attendance.clock.out',
            )}
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
