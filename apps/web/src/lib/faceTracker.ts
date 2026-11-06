/**
 * Live face tracking for the liveness prompts (2026-11-06). MediaPipe's
 * BlazeFace detector runs in the page on the camera frames, so the phone
 * can say "turn left" and take the frame itself the moment the head is
 * turned. It only guides: the server checks the frames it receives
 * (apps/api/src/services/face/liveness.ts) and decides.
 *
 * About 13 MB of WebAssembly, loaded only when a store has liveness on,
 * from our own /assets (hashed, cached by the service worker after the
 * first time). If it cannot load, the camera falls back to a shutter
 * button and the person turns their head on the prompt.
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

let loading: Promise<FaceTracker | null> | null = null;

/** The tracker, or null where it cannot run (the shutter button is used then). */
export function loadFaceTracker(): Promise<FaceTracker | null> {
  loading ??= (async () => {
    try {
      const { FaceDetector } = await import('@mediapipe/tasks-vision');
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
