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
 * steps start once it is ready). If it cannot run on the phone, or takes
 * too long, the shutter button is used and the person turns their head on
 * the prompt; the server checks those frames the same way.
 */
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import modelPath from '../assets/mediapipe/blaze_face_short_range.tflite?url';

export interface FaceReading {
  /** Faces in the frame. */
  count: number;
  /**
   * The largest face's head turn, as the server measures it: the nose's
   * offset from the eyes' midpoint in eye distances, positive when the
   * person turned to their own left (unmirrored frame). Null without a face.
   */
  yaw: number | null;
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

/** The WebAssembly's size after decompression, for the progress bar. */
const WASM_BYTES = 13_520_000;

export type TrackerProgress = { loaded: number; total: number };
let progress: TrackerProgress | null = null;
const listeners = new Set<(p: TrackerProgress) => void>();

/** Download progress of the tracker; called at once with the latest. */
export function onTrackerProgress(fn: (p: TrackerProgress) => void): () => void {
  listeners.add(fn);
  if (progress) fn(progress);
  return () => listeners.delete(fn);
}

function emit(p: TrackerProgress) {
  progress = p;
  for (const fn of listeners) fn(p);
}

/**
 * Fetch the WebAssembly ourselves to count the bytes; MediaPipe's own
 * fetch of the same URL then comes from the browser and service worker
 * caches (the response is immutable).
 */
async function prefetch(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    emit({ loaded: Math.min(loaded, WASM_BYTES), total: WASM_BYTES });
  }
  emit({ loaded: WASM_BYTES, total: WASM_BYTES });
}

let loading: Promise<FaceTracker | null> | null = null;

/** The tracker, or null where it cannot run (the shutter button is used then). */
export function loadFaceTracker(): Promise<FaceTracker | null> {
  loading ??= (async () => {
    try {
      const [{ FaceDetector }] = await Promise.all([
        import('@mediapipe/tasks-vision'),
        prefetch(wasmBinaryPath).catch(() => {}),
      ]);
      const detector = await FaceDetector.createFromOptions(
        { wasmLoaderPath, wasmBinaryPath },
        {
          baseOptions: { modelAssetPath: modelPath },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.6,
        },
      );
      let last = 0;
      return {
        read(video) {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (!w || !h) return { count: 0, yaw: null };
          // detectForVideo needs increasing timestamps.
          last = Math.max(last + 1, performance.now());
          const found = detector.detectForVideo(video, last).detections;
          if (found.length === 0) return { count: 0, yaw: null };
          const area = (d: (typeof found)[number]) =>
            (d.boundingBox?.width ?? 0) * (d.boundingBox?.height ?? 0);
          const best = found.reduce((a, b) => (area(b) > area(a) ? b : a));
          // BlazeFace keypoints: eyes, nose tip, mouth, ears (normalised).
          const k = best.keypoints;
          if (k.length < 3) return { count: found.length, yaw: null };
          const px = (p: { x: number; y: number }) => ({ x: p.x * w, y: p.y * h });
          return { count: found.length, yaw: yawFrom(px(k[0]!), px(k[1]!), px(k[2]!)) };
        },
        close() {
          detector.close();
        },
      } satisfies FaceTracker;
    } catch {
      loading = null;
      return null;
    }
  })();
  return loading;
}
