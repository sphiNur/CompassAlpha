/**
 * The camera and the face tracker, shared by the punch camera and the face
 * enrollment (2026-11-06). Face only: a face photo is taken by the tracker
 * when the head is where the prompt asks, never by a button, and never
 * picked from the gallery.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  grabFrame,
  isCameraError,
  startCamera,
  stopCamera,
  type Facing,
} from '../../lib/attendanceCamera';
import {
  loadFaceTracker,
  onTrackerProgress,
  type FaceReading,
  type FaceTracker,
  type TrackerKind,
} from '../../lib/faceTracker';
import { steadyCounter, type Guide } from './faceGuide';

export type CameraProblem = 'unsupported' | 'denied' | 'unavailable';

function onVisibility(change: () => void): () => void {
  document.addEventListener('visibilitychange', change);
  return () => document.removeEventListener('visibilitychange', change);
}

/**
 * Whether the page is visible. Review MWD-06 (modern-web-guidance:
 * efficient-background-processing): the tracker loops below run only while
 * it is, so a minimised Mini App or a background tab does not keep running
 * face inference every 50 and 120 ms. The camera stream itself stays open:
 * the guide does not ask to stop it, and reopening it on return would show
 * the permission prompt again in some WebViews.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    onVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

/** The camera facing `facing` while it is set; one camera at a time. */
export function useCamera(facing: Facing | null) {
  // A callback ref: the sheet mounts its content after it opens.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<CameraProblem | null>(null);

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

  /** The current frame, or null (and the problem set) when the camera failed. */
  const grab = (maxSide?: number): string | null => {
    if (!video) return null;
    try {
      return grabFrame(video, maxSide);
    } catch {
      setProblem('unavailable');
      return null;
    }
  };

  return { video, setVideo, ready, setReady, problem, grab };
}

/** The face tracker while `open`: downloaded once (a few MB), then cached. */
export function useTracker(open: boolean, kind: TrackerKind = 'landmarker') {
  const [tracker, setTracker] = useState<FaceTracker | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [percent, setPercent] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSlow(false);
    const stop = onTrackerProgress((p) => setPercent(Math.floor((p.loaded / p.total) * 100)), kind);
    const timer = setTimeout(() => setSlow(true), 30_000);
    void loadFaceTracker(kind).then((t) => {
      if (cancelled) return;
      setTracker(t);
      setState(t ? 'ready' : 'failed');
    });
    return () => {
      cancelled = true;
      stop();
      clearTimeout(timer);
    };
  }, [open, kind]);
  return { tracker, state, percent, slow };
}

/**
 * Reads the tracker every ~120 ms while `active`; once `check` has passed
 * HOLD readings in a row (faceGuide.ts), calls `onHeld` (once).
 */
export function useAutoCapture({
  active,
  video,
  tracker,
  check,
  onHeld,
  onGuide,
  key,
}: {
  active: boolean;
  video: HTMLVideoElement | null;
  tracker: FaceTracker | null;
  check: (r: FaceReading, since: number) => Guide | null;
  onHeld: () => void;
  onGuide: (g: Guide | null) => void;
  /** Restarts the loop (the step). */
  key: string;
}) {
  const checkRef = useRef(check);
  checkRef.current = check;
  const heldRef = useRef(onHeld);
  heldRef.current = onHeld;
  const guideRef = useRef(onGuide);
  guideRef.current = onGuide;
  const visible = usePageVisible();
  useEffect(() => {
    // Hidden (MWD-06): no readings; the hold starts again on return.
    if (!active || !visible || !video || !tracker) return;
    const started = performance.now();
    const steady = steadyCounter();
    const timer = setInterval(() => {
      const next = checkRef.current(tracker.read(video), performance.now() - started);
      guideRef.current(next);
      if (steady(next)) {
        clearInterval(timer);
        heldRef.current();
      }
    }, 120);
    return () => clearInterval(timer);
  }, [active, visible, video, tracker, key]);
}

/**
 * Calls `onReading` with a tracker reading about every 50 ms while
 * `active` (blink and open mouth, 2026-11-07: a blink lasts ~150 ms, too
 * short for the 120 ms hold loop above).
 */
export function useFrameLoop({
  active,
  video,
  tracker,
  key,
  onReading,
}: {
  active: boolean;
  video: HTMLVideoElement | null;
  tracker: FaceTracker | null;
  /** Restarts the loop (the step). */
  key: string;
  onReading: (r: FaceReading, now: number) => boolean | void;
}) {
  const readRef = useRef(onReading);
  readRef.current = onReading;
  const visible = usePageVisible();
  useEffect(() => {
    // Hidden (MWD-06): no readings until the page is visible again.
    if (!active || !visible || !video || !tracker) return;
    const timer = setInterval(() => {
      // `true` from the callback: this step is over.
      if (readRef.current(tracker.read(video), performance.now()) === true) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [active, visible, video, tracker, key]);
}
