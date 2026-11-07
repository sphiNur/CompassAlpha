/**
 * Live face tracking for the liveness prompts (2026-11-06). MediaPipe's
 * BlazeFace detector runs in the page on the camera frames, so the phone
 * can say "turn left" and take the frame itself the moment the head is
 * turned. It only guides: the server checks the frames it receives
 * (apps/api/src/services/face/liveness.ts) and decides.
 *
 * About 13 MB of WebAssembly (~4 MB compressed), loaded only when a store
 * has liveness on, from our own /assets: hashed, kept at the Cloudflare
 * edge and by the service worker after the first time. The clock page
 * starts the download when it opens, before anyone taps clock in, and the
 * camera waits for it with a progress bar (owner, 2026-11-06: the face
 * steps start once it is ready).
 *
 * Face only (owner, 2026-11-06): every face photo, for a punch or for the
 * enrollment, is taken by the tracker; there is no shutter for the face.
 * A phone that cannot run it cannot clock by itself (a colleague's phone
 * or a manager's manual punch then).
 *
 * The face enrollment ring (2026-11-07) uses MediaPipe's Face Landmarker
 * instead (`loadFaceTracker('landmarker')`, ~3.7 MB more): 478 points that
 * stay steady from frame to frame, read on every video frame, so the ring
 * follows the head instead of jumping. The turn and tilt are measured from
 * its eye, nose and mouth points exactly as from BlazeFace's.
 */
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import detectorModelPath from '../assets/mediapipe/blaze_face_short_range.tflite?url';
import landmarkerModelPath from '../assets/mediapipe/face_landmarker.task?url';

/** `detector`: BlazeFace, for the punch camera. `landmarker`: the enrollment ring. */
export type TrackerKind = 'detector' | 'landmarker';

export interface FaceReading {
  /** Faces in the frame. */
  count: number;
  /**
   * The largest face's head turn, as the server measures it: the nose's
   * offset from the eyes' midpoint in eye distances, positive when the
   * person turned to their own left (unmirrored frame). Null without a face.
   */
  yaw: number | null;
  /**
   * The nose between the eyes and the mouth, top to bottom: about 0.5
   * looking straight, smaller with the chin up, larger with it down.
   */
  pitch: number | null;
  /** The face's width as a share of the frame's. */
  size: number | null;
  /** The face box's centre, 0–1 across and down the (unmirrored) frame. */
  cx: number | null;
  cy: number | null;
}

export interface FaceTracker {
  read(video: HTMLVideoElement): FaceReading;
  close(): void;
}

type Point = { x: number; y: number };

/** yaw from two eyes and the nose tip, in pixels. */
export function yawFrom(eyeA: Point, eyeB: Point, nose: Point): number {
  const dist = Math.hypot(eyeB.x - eyeA.x, eyeB.y - eyeA.y) || 1;
  return (nose.x - (eyeA.x + eyeB.x) / 2) / dist;
}

/** pitch from two eyes, the nose tip and the mouth, in pixels. */
export function pitchFrom(eyeA: Point, eyeB: Point, nose: Point, mouth: Point): number {
  const eyes = (eyeA.y + eyeB.y) / 2;
  const span = mouth.y - eyes || 1;
  return (nose.y - eyes) / span;
}

/** The WebAssembly's size after decompression, for the progress bar. */
const WASM_BYTES = 13_520_000;
const LANDMARKER_BYTES = 3_758_596;

export type TrackerProgress = { loaded: number; total: number };
const progress: Partial<Record<TrackerKind, TrackerProgress>> = {};
const listeners = new Set<{ kind: TrackerKind; fn: (p: TrackerProgress) => void }>();

/** Download progress of a tracker; called at once with the latest. */
export function onTrackerProgress(
  fn: (p: TrackerProgress) => void,
  kind: TrackerKind = 'detector',
): () => void {
  const entry = { kind, fn };
  listeners.add(entry);
  const now = progress[kind];
  if (now) fn(now);
  return () => listeners.delete(entry);
}

function emit(kind: TrackerKind, p: TrackerProgress) {
  progress[kind] = p;
  for (const l of listeners) if (l.kind === kind) l.fn(p);
}

/**
 * Fetch the files ourselves to count the bytes; MediaPipe's own fetch of
 * the same URLs then comes from the browser and service worker caches
 * (the responses are immutable).
 */
async function prefetch(kind: TrackerKind, files: { url: string; bytes: number }[]) {
  const total = files.reduce((a, f) => a + f.bytes, 0);
  let before = 0;
  for (const f of files) {
    try {
      const res = await fetch(f.url);
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          loaded += value.byteLength;
          emit(kind, { loaded: before + Math.min(loaded, f.bytes), total });
        }
      }
    } catch {
      // MediaPipe fetches it again and reports the failure.
    }
    before += f.bytes;
    emit(kind, { loaded: before, total });
  }
}

const loading: Partial<Record<TrackerKind, Promise<FaceTracker | null>>> = {};

/** The tracker, or null where it cannot run (no face clocking on this phone then). */
export function loadFaceTracker(kind: TrackerKind = 'detector'): Promise<FaceTracker | null> {
  loading[kind] ??= (kind === 'detector' ? loadDetector() : loadLandmarker()).then((t) => {
    if (!t) delete loading[kind];
    return t;
  });
  return loading[kind];
}

const NONE = { yaw: null, pitch: null, size: null, cx: null, cy: null };

async function loadDetector(): Promise<FaceTracker | null> {
  try {
    const [{ FaceDetector }] = await Promise.all([
      import('@mediapipe/tasks-vision'),
      prefetch('detector', [{ url: wasmBinaryPath, bytes: WASM_BYTES }]),
    ]);
    const detector = await FaceDetector.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      {
        baseOptions: { modelAssetPath: detectorModelPath },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.6,
      },
    );
    let last = 0;
    return {
      read(video) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return { count: 0, ...NONE };
        // detectForVideo needs increasing timestamps.
        last = Math.max(last + 1, performance.now());
        const found = detector.detectForVideo(video, last).detections;
        if (found.length === 0) return { count: 0, ...NONE };
        const area = (d: (typeof found)[number]) =>
          (d.boundingBox?.width ?? 0) * (d.boundingBox?.height ?? 0);
        const best = found.reduce((a, b) => (area(b) > area(a) ? b : a));
        // BlazeFace keypoints: eyes, nose tip, mouth, ears (normalised).
        const k = best.keypoints;
        if (k.length < 4) return { count: found.length, ...NONE };
        const px = (p: { x: number; y: number }) => ({ x: p.x * w, y: p.y * h });
        const [eyeA, eyeB, nose, mouth] = [px(k[0]!), px(k[1]!), px(k[2]!), px(k[3]!)];
        return {
          count: found.length,
          yaw: yawFrom(eyeA, eyeB, nose),
          pitch: pitchFrom(eyeA, eyeB, nose, mouth),
          size: (best.boundingBox?.width ?? 0) / w,
          cx: best.boundingBox ? (best.boundingBox.originX + best.boundingBox.width / 2) / w : null,
          cy: best.boundingBox
            ? (best.boundingBox.originY + best.boundingBox.height / 2) / h
            : null,
        };
      },
      close() {
        detector.close();
      },
    } satisfies FaceTracker;
  } catch {
    return null;
  }
}

/**
 * Face mesh points used for the turn and tilt: the corners of each eye
 * (their midpoint is the eye), the nose tip, the mouth corners.
 */
export const MESH = {
  eyeA: [33, 133],
  eyeB: [362, 263],
  nose: 1,
  mouth: [61, 291],
} as const;

type Mark = { x: number; y: number };

/** A FaceReading from one face's mesh (normalised points) in a w×h frame. */
export function readMesh(marks: readonly Mark[], w: number, h: number, count: number): FaceReading {
  if (marks.length < 468) return { count, ...NONE };
  const px = (i: number) => ({ x: marks[i]!.x * w, y: marks[i]!.y * h });
  const mid = ([a, b]: readonly [number, number]) => {
    const p = px(a);
    const q = px(b);
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  };
  const eyeA = mid(MESH.eyeA);
  const eyeB = mid(MESH.eyeB);
  const nose = px(MESH.nose);
  const mouth = mid(MESH.mouth);
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const m of marks) {
    if (m.x < minX) minX = m.x;
    if (m.x > maxX) maxX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.y > maxY) maxY = m.y;
  }
  return {
    count,
    yaw: yawFrom(eyeA, eyeB, nose),
    pitch: pitchFrom(eyeA, eyeB, nose, mouth),
    size: maxX - minX,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

async function loadLandmarker(): Promise<FaceTracker | null> {
  try {
    const [{ FaceLandmarker }] = await Promise.all([
      import('@mediapipe/tasks-vision'),
      prefetch('landmarker', [
        { url: wasmBinaryPath, bytes: WASM_BYTES },
        { url: landmarkerModelPath, bytes: LANDMARKER_BYTES },
      ]),
    ]);
    const landmarker = await FaceLandmarker.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      {
        baseOptions: { modelAssetPath: landmarkerModelPath },
        runningMode: 'VIDEO',
        // Two, to notice a second person in the frame.
        numFaces: 2,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      },
    );
    let last = 0;
    return {
      read(video) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return { count: 0, ...NONE };
        last = Math.max(last + 1, performance.now());
        const faces = landmarker.detectForVideo(video, last).faceLandmarks;
        if (faces.length === 0) return { count: 0, ...NONE };
        const width = (f: readonly Mark[]) =>
          Math.max(...f.map((m) => m.x)) - Math.min(...f.map((m) => m.x));
        const best = faces.reduce((a, b) => (width(b) > width(a) ? b : a));
        return readMesh(best, w, h, faces.length);
      },
      close() {
        landmarker.close();
      },
    } satisfies FaceTracker;
  } catch {
    return null;
  }
}
