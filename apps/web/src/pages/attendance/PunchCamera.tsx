/**
 * The clock-in photos (2026-11-05): face (front camera), then the
 * surroundings (rear camera), then a look at all of them before the punch
 * is sent.
 *
 * Liveness (2026-11-06): with `turns`, the face step becomes three front
 * camera frames: straight on, then each head turn in the order the server
 * chose. A face tracker in the page takes each frame by itself once the
 * head is where the prompt asks; the shutter button works too. The server
 * checks the frames; the phone only guides.
 */
import { useEffect, useRef, useState } from 'react';
import { Banner, Button, Sheet } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import {
  fileToJpeg,
  grabFrame,
  isCameraError,
  jpegSrc,
  startCamera,
  stopCamera,
  type Facing,
} from '../../lib/attendanceCamera';
import { loadFaceTracker, type FaceTracker } from '../../lib/faceTracker';

export type Turn = 'left' | 'right';
export type PunchPhotos = { face: string; scene: string; left?: string; right?: string };
type Shot = 'face' | Turn | 'scene';
type Step = Shot | 'review';

/** Where the tracker takes the frame (the server accepts turns from 0.2, straight up to 0.2). */
const STRAIGHT_MAX = 0.12;
const TURN_MIN = 0.35;
/** Readings in a row (~120 ms apart) before the frame is taken. */
const HOLD = 3;

type Guide = 'noFace' | 'manyFaces' | 'lookStraight' | 'turnMore' | null;

export function PunchCamera({
  open,
  kind,
  faceCheck,
  turns,
  forName,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  kind: 'in' | 'out';
  faceCheck: boolean;
  /** The liveness turn order from the server; null = no liveness check. */
  turns: Turn[] | null;
  /** Clocking a colleague in on this phone: their name. */
  forName?: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (photos: PunchPhotos) => void;
}) {
  const i18n = useI18n();
  const sequence: Shot[] = turns ? ['face', ...turns, 'scene'] : ['face', 'scene'];
  const [step, setStep] = useState<Step>('face');
  const [shots, setShots] = useState<Partial<Record<Shot, string>>>({});
  const [problem, setProblem] = useState<'unsupported' | 'denied' | 'unavailable' | null>(null);
  const [ready, setReady] = useState(false);
  // A callback ref: the sheet mounts its content after it opens.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [tracker, setTracker] = useState<FaceTracker | null>(null);
  const [guide, setGuide] = useState<Guide>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Start over each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setStep('face');
    setShots({});
    setProblem(null);
    setGuide(null);
  }, [open]);

  const live = turns !== null;
  useEffect(() => {
    if (!open || !live) return;
    let cancelled = false;
    void loadFaceTracker().then((t) => {
      if (!cancelled) setTracker(t);
    });
    return () => {
      cancelled = true;
    };
  }, [open, live]);

  // One camera at a time: the front one stays on through the face and
  // turn frames, then stops before the rear one opens.
  const facing: Facing | null =
    !open || step === 'review' ? null : step === 'scene' ? 'environment' : 'user';
  useEffect(() => {
    if (!facing) return;
    let opened: MediaStream | null = null;
    let cancelled = false;
    setReady(false);
    setProblem(null);
    startCamera(facing)
      .then((s) => {
        if (cancelled) return stopCamera(s);
        opened = s;
        setStream(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setProblem(isCameraError(e) ? e.reason : 'unavailable');
      });
    return () => {
      cancelled = true;
      stopCamera(opened);
      setStream(null);
    };
  }, [facing]);

  useEffect(() => {
    if (!video) return;
    video.srcObject = stream;
    if (stream) void video.play().catch(() => {});
  }, [video, stream]);

  const keep = (b64: string) => {
    haptic('light');
    if (step === 'review') return;
    const next = { ...shots, [step]: b64 };
    setShots(next);
    setGuide(null);
    setStep(sequence.find((s) => !next[s]) ?? 'review');
  };

  const shoot = () => {
    if (!video) return;
    try {
      keep(grabFrame(video));
    } catch {
      setProblem('unavailable');
    }
  };

  // The tracker takes the face and turn frames by itself.
  const auto =
    tracker && ready && !problem && (step === 'face' || step === 'left' || step === 'right');
  const shootRef = useRef(shoot);
  shootRef.current = shoot;
  useEffect(() => {
    if (!auto || !video || !tracker || !turns) return;
    let held = 0;
    const timer = setInterval(() => {
      const r = tracker.read(video);
      let next: Guide = null;
      if (r.count === 0 || r.yaw === null) next = 'noFace';
      else if (r.count > 1) next = 'manyFaces';
      else if (step === 'face' && Math.abs(r.yaw) > STRAIGHT_MAX) next = 'lookStraight';
      else if (step === 'left' && r.yaw < TURN_MIN) next = 'turnMore';
      else if (step === 'right' && r.yaw > -TURN_MIN) next = 'turnMore';
      setGuide(next);
      held = next === null ? held + 1 : 0;
      if (held >= HOLD) {
        clearInterval(timer);
        shootRef.current();
      }
    }, 120);
    return () => clearInterval(timer);
  }, [auto, video, tracker, step, turns]);

  const fromSystemCamera = async (file: File | undefined) => {
    if (!file) return;
    try {
      keep(await fileToJpeg(file));
    } catch {
      haptic('error');
      setProblem('unavailable');
    }
  };

  /** Retaking any face frame retakes all of them, in order. */
  const retake = (which: Shot) => {
    if (which === 'scene') {
      setShots((s) => ({ ...s, scene: undefined }));
      setStep('scene');
      return;
    }
    setShots((s) => ({ scene: s.scene }));
    setStep('face');
  };

  const title =
    step === 'review'
      ? i18n.t('attendance.photo.reviewTitle')
      : step === 'scene'
        ? i18n.t('attendance.photo.sceneTitle')
        : step === 'left'
          ? i18n.t('attendance.live.turnLeft')
          : step === 'right'
            ? i18n.t('attendance.live.turnRight')
            : live
              ? i18n.t('attendance.live.lookTitle')
              : i18n.t('attendance.photo.faceTitle');
  const hint =
    step === 'review'
      ? i18n.t(faceCheck ? 'attendance.photo.reviewHintFace' : 'attendance.photo.reviewHint')
      : step === 'scene'
        ? i18n.t('attendance.photo.sceneHint')
        : live
          ? i18n.t(tracker ? 'attendance.live.autoHint' : 'attendance.live.manualHint')
          : i18n.t('attendance.photo.faceHint');
  const reviewShots: Shot[] = turns ? ['face', ...turns, 'scene'] : ['face', 'scene'];
  const front = step === 'face' || step === 'left' || step === 'right';

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !busy && onCancel()}
      title={title}
      description={hint}
    >
      <div className="flex flex-col gap-3 py-3">
        {forName ? (
          <p className="text-old-label font-semibold text-[var(--c-fg)]">
            {i18n.t('attendance.borrow.forWhom', { name: forName })}
          </p>
        ) : null}
        {step !== 'review' ? (
          problem ? null : (
            <div className="relative overflow-hidden rounded-[var(--r-card)] bg-black">
              <video
                ref={setVideo}
                playsInline
                muted
                autoPlay
                onLoadedData={() => setReady(true)}
                aria-label={title}
                className={`aspect-[3/4] w-full object-cover ${front ? '-scale-x-100' : ''}`}
              />
              {live && front ? (
                <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-3 pb-3 pt-8 text-center text-white">
                  <span className="text-old-h3 font-semibold">
                    {step === 'left' ? '←' : step === 'right' ? '→' : '●'} {title}
                  </span>
                  {auto && guide ? (
                    <span className="text-old-label">
                      {i18n.t(`attendance.live.guide.${guide}`)}
                    </span>
                  ) : null}
                  <span className="text-old-label opacity-80" aria-live="polite">
                    {i18n.t('attendance.live.progress', {
                      done: (['face', ...(turns ?? [])] as Shot[]).filter((s) => shots[s]).length,
                      total: 1 + (turns?.length ?? 0),
                    })}
                  </span>
                </div>
              ) : null}
              {shots.face && step === 'scene' ? (
                <img
                  src={jpegSrc(shots.face)}
                  alt={i18n.t('attendance.photo.face')}
                  className="absolute left-2 top-2 h-20 w-16 rounded-md object-cover ring-2 ring-white"
                />
              ) : null}
            </div>
          )
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {reviewShots.map((which) => {
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
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => retake(which)}>
                      {i18n.t('attendance.photo.retake')}
                    </Button>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}

        {problem ? (
          <Banner tone="warn" title={i18n.t(`attendance.photo.problem.${problem}`)}>
            {i18n.t('attendance.photo.useSystemCamera')}
          </Banner>
        ) : null}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture={step === 'scene' ? 'environment' : 'user'}
          className="hidden"
          onChange={(e) => {
            void fromSystemCamera(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        {step === 'review' ? (
          <Button
            block
            size="lg"
            loading={busy}
            disabled={reviewShots.some((s) => !shots[s])}
            onClick={() =>
              shots.face &&
              shots.scene &&
              onConfirm({
                face: shots.face,
                scene: shots.scene,
                left: shots.left,
                right: shots.right,
              })
            }
          >
            {i18n.t(kind === 'in' ? 'attendance.clock.in' : 'attendance.clock.out')}
          </Button>
        ) : problem ? (
          <Button block size="lg" onClick={() => fileRef.current?.click()}>
            {i18n.t('attendance.photo.openSystemCamera')}
          </Button>
        ) : (
          <Button
            block
            size="lg"
            variant={auto ? 'secondary' : 'primary'}
            disabled={!ready}
            onClick={shoot}
          >
            {i18n.t('attendance.photo.shoot')}
          </Button>
        )}
      </div>
    </Sheet>
  );
}
