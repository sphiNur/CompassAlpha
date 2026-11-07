/**
 * The camera and the face tracker, shared by the punch camera and the face
 * enrollment (2026-11-06). Face only: a face photo is taken by the tracker
 * when the head is where the prompt asks, never by a button, and never
 * picked from the gallery.
 */
import { useEffect, useRef, useState } from 'react';
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

export type CameraProblem = 'unsupported' | 'denied' | 'unavailable';

/** What the person should do before the frame is taken; null = hold still. */
export type Guide =
  | 'noFace'
  | 'manyFaces'
  | 'closer'
  | 'lookStraight'
  | 'turnMore'
  | 'chinUp'
  | 'chinDown';

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
export function useTracker(open: boolean, kind: TrackerKind = 'detector') {
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

/** Readings in a row (~120 ms apart) before the frame is taken. */
const HOLD = 3;

/**
 * Reads the tracker every ~120 ms while `active`; once `check` has passed
 * HOLD readings in a row, calls `onHeld` (once).
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
  useEffect(() => {
    if (!active || !video || !tracker) return;
    const started = performance.now();
    let held = 0;
    const timer = setInterval(() => {
      const next = checkRef.current(tracker.read(video), performance.now() - started);
      guideRef.current(next);
      held = next === null ? held + 1 : 0;
      if (held >= HOLD) {
        clearInterval(timer);
        heldRef.current();
      }
    }, 120);
    return () => clearInterval(timer);
  }, [active, video, tracker, key]);
}

/** The usual first checks: one face, close enough. */
export function basicGuide(r: FaceReading, minSize = 0.28): Guide | null {
  if (r.count === 0 || r.yaw === null) return 'noFace';
  if (r.count > 1) return 'manyFaces';
  if (r.size !== null && r.size < minSize) return 'closer';
  return null;
}
