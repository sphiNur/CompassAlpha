/**
 * Face check for attendance photos (2026-11-05, owner request; runs on our
 * own server — owner decision). `faceFeature(bytes)` → the photo's face
 * feature, or `found: false`; `null` when the check could not run (the
 * punch then goes through, marked for the manager to look at).
 *
 * The first face becomes the member's reference; later photos are matched
 * by cosine against it. Threshold 0.363 is OpenCV's value for SFace.
 */
import { logger } from '../../infra/log';
import type { FaceResult } from './pipeline';

export type { FaceResult } from './pipeline';

export const MATCH_THRESHOLD = 0.363;
const TIMEOUT_MS = 20_000;

type Engine = (bytes: Uint8Array, signal?: AbortSignal) => Promise<FaceResult>;

/**
 * Frames that may wait for the worker. Review (2026-11-23): every frame
 * was posted at once with no limit, and a frame whose caller had given up
 * (TIMEOUT_MS) still ran, so one member's ten enrolment frames, or a
 * burst of punches, made everyone else's checks time out. A frame takes
 * about 0.5 s, so more than this many waiting would time out anyway;
 * failing at once (faceCheckUnavailable) is the same answer, sooner.
 */
export const MAX_WAITING_FRAMES = 40;

interface Job {
  bytes: Uint8Array;
  resolve: (r: FaceResult) => void;
  reject: (e: Error) => void;
}

/**
 * One frame at a time, in order, at most `maxWaiting` waiting. A waiting
 * frame whose signal aborts is dropped before it runs. `run` does one
 * frame (the worker; a stub in tests). Exported for tests.
 */
export function createFrameQueue(
  run: (bytes: Uint8Array) => Promise<FaceResult>,
  maxWaiting = MAX_WAITING_FRAMES,
): { submit: Engine; waiting: () => number } {
  const queue: Job[] = [];
  let busy = false;
  const pump = () => {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    run(job.bytes)
      .then(job.resolve, job.reject)
      .finally(() => {
        busy = false;
        pump();
      });
  };
  const submit: Engine = (bytes, signal) =>
    new Promise<FaceResult>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('face check cancelled'));
      if (queue.length >= maxWaiting) return reject(new Error('face queue full'));
      const job: Job = { bytes, resolve, reject };
      queue.push(job);
      signal?.addEventListener(
        'abort',
        () => {
          const at = queue.indexOf(job);
          if (at >= 0) {
            queue.splice(at, 1);
            reject(new Error('face check cancelled'));
          }
        },
        { once: true },
      );
      pump();
    });
  return { submit, waiting: () => queue.length };
}

let worker: Worker | null = null;
let seq = 0;
const inWorker = new Map<
  number,
  { resolve: (r: FaceResult) => void; reject: (e: Error) => void }
>();

/** One frame through the worker thread. */
function viaWorker(bytes: Uint8Array): Promise<FaceResult> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url).href);
    worker.onmessage = (
      event: MessageEvent<{ id: number; result?: FaceResult; error?: string }>,
    ) => {
      const job = inWorker.get(event.data.id);
      if (!job) return;
      inWorker.delete(event.data.id);
      if (event.data.result) job.resolve(event.data.result);
      else job.reject(new Error(event.data.error ?? 'face worker failed'));
    };
    worker.onerror = (event) => {
      logger.error({ message: event.message }, 'face worker crashed');
      for (const job of inWorker.values()) job.reject(new Error('face worker crashed'));
      inWorker.clear();
      worker?.terminate();
      worker = null;
    };
    // Don't keep the process alive just for the worker.
    (worker as unknown as { unref?: () => void }).unref?.();
  }
  const id = ++seq;
  return new Promise<FaceResult>((resolve, reject) => {
    inWorker.set(id, { resolve, reject });
    worker!.postMessage({ id, bytes });
  });
}

const frames = createFrameQueue(viaWorker);
let engine: Engine = frames.submit;

/** Tests swap the model for a stub. */
export function setFaceEngineForTests(
  next: ((bytes: Uint8Array) => Promise<FaceResult>) | null,
): void {
  engine = next ?? frames.submit;
}

export async function faceFeature(bytes: Uint8Array): Promise<FaceResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new AbortController();
  try {
    return await Promise.race([
      engine(bytes, gaveUp.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // A frame still waiting is dropped rather than run for no one.
          gaveUp.abort();
          reject(new Error('face check timed out'));
        }, TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    logger.warn({ err }, 'face check failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i]! * b[i]!;
  return s;
}
