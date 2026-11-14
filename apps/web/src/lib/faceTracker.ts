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
 *
 * Review MWD-05 (modern-web-guidance: performance), 2026-11-14: the
 * inference runs in a Web Worker (faceWorker.ts) where the phone allows
 * it, so the 50 and 120 ms loops no longer block taps on the sheet. The
 * page grabs each frame as an ImageBitmap, one frame in flight at a time
 * (faceFrames.ts), and the photo is taken from the frame the reading is
 * of. Without Worker, OffscreenCanvas or createImageBitmap, or when the
 * worker does not start (no WebGL in workers on some iOS), the tracker
 * runs on the page as before.
 */
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import landmarkerModelPath from '../assets/mediapipe/face_landmarker.task?url';
import { getLogger } from '@compass/telemetry';
import { runningBuildId } from './build';
import {
  createFramePump,
  workerSupported,
  type FramePump,
  type FreshReading,
  type FromWorker,
  type ToWorker,
} from './faceFrames';
import { LANDMARKER_OPTIONS, NONE, readResult, type FaceReading } from './faceMesh';
import { readLocalPref, writeLocalPref } from './localPref';

/** One kind since 2026-11-07 (the landmarker); kept as a name for the progress listeners. */
export type TrackerKind = 'landmarker';

/** What the tracker gives each frame (faceMesh.ts). */
export type { FaceReading } from './faceMesh';
export { MESH, pitchFrom, readMesh, readShapes, yawFrom } from './faceMesh';

/** A reading of a frame no caller has seen yet, with that frame (to photograph). */
export type FaceFrame = FreshReading<HTMLVideoElement | ImageBitmap>;

export interface FaceTracker {
  /** Where the inference runs (review MWD-05). */
  readonly where: 'worker' | 'page';
  /**
   * The latest reading. On the page it is of the video's current frame;
   * from the worker it can be one frame behind, or the same as the last
   * call's. The loops use `poll`; kept for any other caller.
   */
  read(video: HTMLVideoElement): FaceReading;
  /**
   * A reading no earlier poll returned, and the frame it is of (take the
   * photo from that frame: it shows what the reading says), or null when
   * none is ready yet: skip this tick. On the page, every poll reads the
   * video's current frame.
   */
  poll(video: HTMLVideoElement): FaceFrame | null;
  close(): void;
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
/** The loaded tracker, once there is one. */
let current: FaceTracker | null = null;

/** The tracker, or null where it cannot run (no face clocking on this phone then). */
export function loadFaceTracker(kind: TrackerKind = 'landmarker'): Promise<FaceTracker | null> {
  loading[kind] ??= loadAny().then((t) => {
    if (!t) delete loading[kind];
    current = t;
    return t;
  });
  return loading[kind];
}

/**
 * How long the worker outlives the last camera that used it. Review
 * MWD-05: the worker holds the model (tens of MB) and a thread, so it ends
 * when the camera sheets are gone; not at once, so a retry or a second
 * punch does not start it again.
 */
const IDLE_CLOSE_MS = 30_000;
let holders = 0;
let idle: ReturnType<typeof setTimeout> | undefined;

/**
 * Keeps the tracker while a camera shows; the returned function lets it
 * go. When nobody holds it for IDLE_CLOSE_MS, a worker tracker is ended
 * and the next load starts a new one. A tracker on the page stays, as
 * before.
 */
export function holdFaceTracker(): () => void {
  holders += 1;
  clearTimeout(idle);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holders -= 1;
    if (holders === 0) idle = setTimeout(closeIdle, IDLE_CLOSE_MS);
  };
}

function closeIdle() {
  if (holders > 0 || current?.where !== 'worker') return;
  current.close();
  current = null;
  delete loading.landmarker;
}

/** The build the worker failed to start in, on this phone (faceFrames.ts workerSupported). */
const WORKER_FAILED_KEY = 'compass.faceWorker.failed';

function note(level: 'info' | 'warn', action: string, data: Record<string, unknown>) {
  try {
    getLogger().log(level, 'face.tracker', { action, data });
  } catch {
    // No logger yet (tests, an early failure): nothing to report to.
  }
}

async function loadAny(): Promise<FaceTracker | null> {
  const build = runningBuildId();
  const tryWorker = workerSupported(globalThis, readLocalPref(WORKER_FAILED_KEY), build);
  // The page path needs the library on the page; start it with the download.
  const lib = tryWorker ? null : import('@mediapipe/tasks-vision');
  lib?.catch(() => {});
  await prefetch('landmarker', [
    { url: wasmBinaryPath, bytes: WASM_BYTES },
    { url: landmarkerModelPath, bytes: LANDMARKER_BYTES },
  ]);
  if (tryWorker) {
    const t = await loadWorkerTracker();
    if (t) return t;
    writeLocalPref(WORKER_FAILED_KEY, build ?? 'dev');
  }
  const t = await loadLandmarker(lib ?? import('@mediapipe/tasks-vision'));
  note(t ? 'info' : 'warn', t ? 'page' : 'unavailable', { worker: tryWorker });
  return t;
}

async function loadLandmarker(
  lib: Promise<typeof import('@mediapipe/tasks-vision')>,
): Promise<FaceTracker | null> {
  try {
    const { FaceLandmarker } = await lib;
    const landmarker = await FaceLandmarker.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      // CPU, MediaPipe's default delegate (as before MWD-05).
      { ...LANDMARKER_OPTIONS, baseOptions: { modelAssetPath: landmarkerModelPath } },
    );
    let last = 0;
    const read = (video: HTMLVideoElement): FaceReading => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return { count: 0, ...NONE };
      last = Math.max(last + 1, performance.now());
      return readResult(landmarker.detectForVideo(video, last), w, h);
    };
    return {
      where: 'page',
      read,
      poll(video) {
        const at = performance.now();
        return { reading: read(video), frame: video, at };
      },
      close() {
        landmarker.close();
      },
    } satisfies FaceTracker;
  } catch {
    return null;
  }
}

/** The worker's start: compiling the wasm and the model, files already downloaded. */
const WORKER_START_MS = 45_000;

/** An absolute URL: the worker resolves relative ones against its own script. */
const absolute = (path: string) => new URL(path, document.baseURI).href;

/**
 * Review MWD-05 (modern-web-guidance: performance): the tracker in a Web
 * Worker (faceWorker.ts), or null when the worker cannot start (the page
 * runs it then). After a good start, a worker that crashes, hangs or
 * fails frames in a row is ended and the page loads its own tracker; the
 * loops get no readings for those few seconds.
 */
async function loadWorkerTracker(): Promise<FaceTracker | null> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./faceWorker.ts', import.meta.url), { name: 'face-tracker' });
  } catch (e) {
    note('warn', 'workerFailed', { why: e instanceof Error ? e.message : String(e) });
    return null;
  }
  const started = await new Promise<Extract<FromWorker, { type: 'ready' }> | string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), WORKER_START_MS);
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type === 'ready') resolve(e.data);
      else if (e.data.type === 'failed') resolve(e.data.message);
      else return;
      clearTimeout(timer);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      clearTimeout(timer);
      resolve(e.message || 'worker error');
    };
    worker.postMessage({
      type: 'init',
      wasmLoaderPath: absolute(wasmLoaderPath),
      wasmBinaryPath: absolute(wasmBinaryPath),
      modelAssetPath: absolute(landmarkerModelPath),
    } satisfies ToWorker);
  });
  if (typeof started === 'string') {
    worker.terminate();
    note('warn', 'workerFailed', { why: started });
    return null;
  }
  note('info', 'worker', {
    delegate: started.delegate,
    ms: Math.round(started.ms),
    gpuError: started.gpuError,
  });
  return workerTracker(worker);
}

function workerTracker(worker: Worker): FaceTracker {
  let page: FaceTracker | null = null;
  let gaveUp = false;
  let closed = false;
  let last: FaceReading = { count: 0, ...NONE };

  function giveUp(why: string) {
    if (gaveUp) return;
    gaveUp = true;
    pump.close();
    worker.terminate();
    writeLocalPref(WORKER_FAILED_KEY, runningBuildId() ?? 'dev');
    note('warn', 'workerLost', { why });
    void loadLandmarker(import('@mediapipe/tasks-vision')).then((t) => {
      if (closed) t?.close();
      else page = t;
    });
  }

  const pump: FramePump<ImageBitmap> = createFramePump<ImageBitmap>({
    now: () => performance.now(),
    send: (frame, at, id) =>
      worker.postMessage({ type: 'frame', id, at, frame } satisfies ToWorker, [frame]),
    drop: (frame) => frame.close(),
    broken: giveUp,
  });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'result') pump.deliver(m.id, m.reading, m.frame);
    else if (m.type === 'error') pump.fail(m.id, m.frame);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    giveUp(e.message || 'worker error');
  };
  // HAVE_CURRENT_DATA: before it, createImageBitmap(video) rejects.
  const capture = (video: HTMLVideoElement) =>
    video.videoWidth && video.videoHeight && video.readyState >= 2
      ? createImageBitmap(video)
      : null;

  const poll = (video: HTMLVideoElement): FaceFrame | null => {
    if (page) return page.poll(video);
    const got = pump.poll(() => capture(video));
    if (got) last = got.reading;
    return got;
  };
  return {
    where: 'worker',
    poll,
    read: (video) => (page ? page.read(video) : (poll(video)?.reading ?? last)),
    close() {
      closed = true;
      pump.close();
      worker.terminate();
      page?.close();
      page = null;
    },
  } satisfies FaceTracker;
}
