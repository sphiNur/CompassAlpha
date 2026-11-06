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

type Engine = (bytes: Uint8Array) => Promise<FaceResult>;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (r: FaceResult) => void; reject: (e: Error) => void }>();

function viaWorker(bytes: Uint8Array): Promise<FaceResult> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url).href);
    worker.onmessage = (
      event: MessageEvent<{ id: number; result?: FaceResult; error?: string }>,
    ) => {
      const job = waiting.get(event.data.id);
      if (!job) return;
      waiting.delete(event.data.id);
      if (event.data.result) job.resolve(event.data.result);
      else job.reject(new Error(event.data.error ?? 'face worker failed'));
    };
    worker.onerror = (event) => {
      logger.error({ message: event.message }, 'face worker crashed');
      for (const job of waiting.values()) job.reject(new Error('face worker crashed'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
    // Don't keep the process alive just for the worker.
    (worker as unknown as { unref?: () => void }).unref?.();
  }
  const id = ++seq;
  return new Promise<FaceResult>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker!.postMessage({ id, bytes });
  });
}

let engine: Engine = viaWorker;

/** Tests swap the model for a stub. */
export function setFaceEngineForTests(next: Engine | null): void {
  engine = next ?? viaWorker;
}

export async function faceFeature(bytes: Uint8Array): Promise<FaceResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      engine(bytes),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('face check timed out')), TIMEOUT_MS);
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
