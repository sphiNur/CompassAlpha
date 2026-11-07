/**
 * Live face tracking for the face prompts (2026-11-06). MediaPipe's Face
 * Landmarker runs in the page on the camera frames, so the phone can say
 * "turn left", "blink" or "open your mouth" and take the frame itself the
 * moment it happens. It only guides: the server checks the frames it
 * receives (apps/api/src/services/face/liveness.ts) and decides.
 *
 * About 13 MB of WebAssembly (~4 MB compressed) and a 3.7 MB model, from
 * our own /assets: hashed, kept at the Cloudflare edge and by the service
 * worker after the first time. The clock page starts the download when it
 * opens, before anyone taps clock in, and the camera waits for it with a
 * progress bar.
 *
 * Face only (owner, 2026-11-06): every face photo, for a punch or for the
 * enrollment, is taken by the tracker; there is no shutter for the face.
 * A phone that cannot run it cannot clock by itself (a colleague's phone
 * or a manager's manual punch then).
 *
 * The landmarker (2026-11-07) gives 478 points that stay steady from frame
 * to frame, for the enrollment ring, and the blink and jaw-open scores for
 * the blink and open-mouth prompts on every punch. The punch camera used
 * BlazeFace before; its four keypoints could not see eyelids. The turn
 * and tilt are measured from the eye, nose and mouth points the same way
 * as on the server.
 */
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import landmarkerModelPath from '../assets/mediapipe/face_landmarker.task?url';

/** One kind since 2026-11-07 (the landmarker); kept as a name for the progress listeners. */
export type TrackerKind = 'landmarker';

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
  /** How closed the eyes are, 0 (open) – 1 (shut): both eyes' blendshape, averaged. */
  blink: number | null;
  /** How open the mouth is, 0 (shut) – 1 (wide): the jawOpen blendshape. */
  jaw: number | null;
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
  kind: TrackerKind = 'landmarker',
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
export function loadFaceTracker(kind: TrackerKind = 'landmarker'): Promise<FaceTracker | null> {
  loading[kind] ??= loadLandmarker().then((t) => {
    if (!t) delete loading[kind];
    return t;
  });
  return loading[kind];
}

const NONE = { yaw: null, pitch: null, size: null, cx: null, cy: null, blink: null, jaw: null };

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
export function readMesh(
  marks: readonly Mark[],
  w: number,
  h: number,
  count: number,
  shapes: { blink: number | null; jaw: number | null } = { blink: null, jaw: null },
): FaceReading {
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
    blink: shapes.blink,
    jaw: shapes.jaw,
  };
}

type Shape = { categoryName: string; score: number };

/** The blink and jaw-open scores from one face's blendshapes. */
export function readShapes(shapes: readonly Shape[] | undefined): {
  blink: number | null;
  jaw: number | null;
} {
  if (!shapes || shapes.length === 0) return { blink: null, jaw: null };
  const score = (name: string) => shapes.find((x) => x.categoryName === name)?.score ?? null;
  const l = score('eyeBlinkLeft');
  const r = score('eyeBlinkRight');
  return { blink: l !== null && r !== null ? (l + r) / 2 : null, jaw: score('jawOpen') };
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
        // Blink and open mouth (2026-11-07).
        outputFaceBlendshapes: true,
      },
    );
    let last = 0;
    return {
      read(video) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return { count: 0, ...NONE };
        last = Math.max(last + 1, performance.now());
        const result = landmarker.detectForVideo(video, last);
        const faces = result.faceLandmarks;
        if (faces.length === 0) return { count: 0, ...NONE };
        const width = (f: readonly Mark[]) =>
          Math.max(...f.map((m) => m.x)) - Math.min(...f.map((m) => m.x));
        let best = 0;
        faces.forEach((f, i) => {
          if (width(f) > width(faces[best]!)) best = i;
        });
        const shapes = readShapes(result.faceBlendshapes?.[best]?.categories);
        return readMesh(faces[best]!, w, h, faces.length, shapes);
      },
      close() {
        landmarker.close();
      },
    } satisfies FaceTracker;
  } catch {
    return null;
  }
}
