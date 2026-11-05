/**
 * The two clock-in photos (2026-11-05): face (front camera), then the
 * surroundings (rear camera), then a look at both before the punch is sent.
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

export type PunchPhotos = { face: string; scene: string };
type Step = 'face' | 'scene' | 'review';

const FACING: Record<'face' | 'scene', Facing> = { face: 'user', scene: 'environment' };

export function PunchCamera({
  open,
  kind,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  kind: 'in' | 'out';
  busy: boolean;
  onCancel: () => void;
  onConfirm: (photos: PunchPhotos) => void;
}) {
  const i18n = useI18n();
  const [step, setStep] = useState<Step>('face');
  const [face, setFace] = useState<string | null>(null);
  const [scene, setScene] = useState<string | null>(null);
  const [problem, setProblem] = useState<'unsupported' | 'denied' | 'unavailable' | null>(null);
  const [ready, setReady] = useState(false);
  // A callback ref: the sheet mounts its content after it opens.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Start over each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setStep('face');
    setFace(null);
    setScene(null);
    setProblem(null);
  }, [open]);

  // One camera at a time: stop the last one before the next opens.
  useEffect(() => {
    if (!open || step === 'review') return;
    let opened: MediaStream | null = null;
    let cancelled = false;
    setReady(false);
    setProblem(null);
    startCamera(FACING[step])
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
  }, [open, step]);

  useEffect(() => {
    if (!video) return;
    video.srcObject = stream;
    if (stream) void video.play().catch(() => {});
  }, [video, stream]);

  const keep = (b64: string) => {
    haptic('light');
    if (step === 'face') {
      setFace(b64);
      setStep(scene ? 'review' : 'scene');
    } else if (step === 'scene') {
      setScene(b64);
      setStep('review');
    }
  };

  const shoot = () => {
    if (!video) return;
    try {
      keep(grabFrame(video));
    } catch {
      setProblem('unavailable');
    }
  };

  const fromSystemCamera = async (file: File | undefined) => {
    if (!file) return;
    try {
      keep(await fileToJpeg(file));
    } catch {
      haptic('error');
      setProblem('unavailable');
    }
  };

  const title =
    step === 'face'
      ? i18n.t('attendance.photo.faceTitle')
      : step === 'scene'
        ? i18n.t('attendance.photo.sceneTitle')
        : i18n.t('attendance.photo.reviewTitle');
  const hint =
    step === 'face'
      ? i18n.t('attendance.photo.faceHint')
      : step === 'scene'
        ? i18n.t('attendance.photo.sceneHint')
        : i18n.t('attendance.photo.reviewHint');

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !busy && onCancel()}
      title={title}
      description={hint}
    >
      <div className="flex flex-col gap-3 py-3">
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
                className={`aspect-[3/4] w-full object-cover ${step === 'face' ? '-scale-x-100' : ''}`}
              />
              {face && step === 'scene' ? (
                <img
                  src={jpegSrc(face)}
                  alt={i18n.t('attendance.photo.face')}
                  className="absolute left-2 top-2 h-20 w-16 rounded-md object-cover ring-2 ring-white"
                />
              ) : null}
            </div>
          )
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['face', face],
                ['scene', scene],
              ] as const
            ).map(([which, src]) => (
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
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStep(which)}>
                    {i18n.t('attendance.photo.retake')}
                  </Button>
                </figcaption>
              </figure>
            ))}
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
            disabled={!face || !scene}
            onClick={() => face && scene && onConfirm({ face, scene })}
          >
            {i18n.t(kind === 'in' ? 'attendance.clock.in' : 'attendance.clock.out')}
          </Button>
        ) : problem ? (
          <Button block size="lg" onClick={() => fileRef.current?.click()}>
            {i18n.t('attendance.photo.openSystemCamera')}
          </Button>
        ) : (
          <Button block size="lg" disabled={!ready} onClick={shoot}>
            {i18n.t('attendance.photo.shoot')}
          </Button>
        )}
      </div>
    </Sheet>
  );
}
