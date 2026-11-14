// TT: call installTrustedTypesPolicy() from lib/trustedTypes once that lands
/**
 * The face tracker's worker. Review MWD-05 (modern-web-guidance:
 * performance): MediaPipe's Face Landmarker runs here, off the page's main
 * thread, so a 20–60 ms inference every 50 ms no longer delays taps on the
 * sheet. The page sends one camera frame at a time (an ImageBitmap,
 * transferred) and gets its reading back with the frame (faceFrames.ts).
 *
 * A classic worker, not a module one: MediaPipe loads its wasm loader with
 * importScripts, which a module worker does not have (its `import()`
 * fallback leaves `ModuleFactory` module-scoped, and the start fails).
 * The loader, the wasm and the model are the same /assets files the page
 * path uses, already in the browser, service-worker and edge caches.
 *
 * GPU first (WebGL on an OffscreenCanvas), then CPU, the page path's
 * delegate. Each start is tried on a blank frame, so a phone whose
 * workers have no WebGL fails here and the page falls back to running the
 * tracker itself.
 */
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { Delegate, FromWorker, ToWorker } from './faceFrames';
import { LANDMARKER_OPTIONS, readResult } from './faceMesh';

/** The worker global, typed by hand: the web app's TypeScript lib is DOM, not WebWorker. */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
};

let landmarker: FaceLandmarker | null = null;
let last = 0;

/** VIDEO mode needs rising timestamps; the page's clock is not this worker's. */
function stamp(at: number): number {
  last = Math.max(last + 1, at);
  return last;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function start(paths: Extract<ToWorker, { type: 'init' }>, delegate: Delegate) {
  const made = await FaceLandmarker.createFromOptions(
    { wasmLoaderPath: paths.wasmLoaderPath, wasmBinaryPath: paths.wasmBinaryPath },
    {
      ...LANDMARKER_OPTIONS,
      baseOptions: { modelAssetPath: paths.modelAssetPath, delegate },
      // A worker has no document to make a canvas from.
      canvas: new OffscreenCanvas(1, 1),
    },
  );
  try {
    made.detectForVideo(new ImageData(64, 64), stamp(performance.now()));
  } catch (e) {
    made.close();
    throw e;
  }
  return made;
}

async function init(paths: Extract<ToWorker, { type: 'init' }>) {
  const began = performance.now();
  let gpuError: string | undefined;
  try {
    landmarker = await start(paths, 'GPU');
    scope.postMessage({ type: 'ready', delegate: 'GPU', ms: performance.now() - began });
    return;
  } catch (e) {
    gpuError = message(e);
  }
  try {
    landmarker = await start(paths, 'CPU');
    scope.postMessage({ type: 'ready', delegate: 'CPU', ms: performance.now() - began, gpuError });
  } catch (e) {
    scope.postMessage({ type: 'failed', message: `${message(e)} (GPU: ${gpuError})` });
  }
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    void init(msg);
    return;
  }
  const { id, frame, at } = msg;
  if (!landmarker) {
    scope.postMessage({ type: 'error', id, frame, message: 'not started' }, [frame]);
    return;
  }
  try {
    const result = landmarker.detectForVideo(frame, stamp(at));
    const reading = readResult(result, frame.width, frame.height);
    scope.postMessage({ type: 'result', id, reading, frame }, [frame]);
  } catch (err) {
    scope.postMessage({ type: 'error', id, frame, message: message(err) }, [frame]);
  }
};
