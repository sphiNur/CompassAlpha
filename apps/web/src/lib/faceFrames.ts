/**
 * Review MWD-05 (modern-web-guidance: performance): the face tracker's
 * inference runs in a Web Worker (faceWorker.ts), so the page's main
 * thread only copies a camera frame into an ImageBitmap and hands it
 * over. This file is the pure part: the messages, when the worker can be
 * used at all, and the frame pump that keeps one frame in flight.
 */
import type { FaceReading } from './faceMesh';

export type Delegate = 'GPU' | 'CPU';

/** Page → worker. */
export type ToWorker =
  | { type: 'init'; wasmLoaderPath: string; wasmBinaryPath: string; modelAssetPath: string }
  | { type: 'frame'; id: number; at: number; frame: ImageBitmap };

/** Worker → page. A frame always comes back, so the page can photograph it. */
export type FromWorker =
  | { type: 'ready'; delegate: Delegate; ms: number; gpuError?: string }
  | { type: 'failed'; message: string }
  | { type: 'result'; id: number; reading: FaceReading; frame: ImageBitmap }
  | { type: 'error'; id: number; frame: ImageBitmap | null; message: string };

/**
 * Whether to try the worker. Without Worker, OffscreenCanvas (MediaPipe
 * draws its WebGL there, a worker has no document) or createImageBitmap
 * (the frame handed over), the tracker runs on the page as before. So
 * does a phone on which the worker already failed to start in this build
 * (remembered in localStorage): some iOS versions have OffscreenCanvas
 * without WebGL in workers, and trying again would add the worker's
 * start to every clock-in.
 */
export function workerSupported(
  env: { Worker?: unknown; OffscreenCanvas?: unknown; createImageBitmap?: unknown },
  failedInBuild: string | null,
  build: string | null,
): boolean {
  if (typeof env.Worker !== 'function') return false;
  if (typeof env.OffscreenCanvas !== 'function') return false;
  if (typeof env.createImageBitmap !== 'function') return false;
  return failedInBuild === null || failedInBuild !== (build ?? 'dev');
}

/** A reading of a frame no caller has seen yet, with that frame. */
export interface FreshReading<F> {
  reading: FaceReading;
  /** The frame the reading is of; valid until the next poll. */
  frame: F;
  /** performance.now() when the frame was taken. */
  at: number;
}

export interface PumpOptions<F> {
  now(): number;
  /** Hands the frame to the worker (transferred). */
  send(frame: F, at: number, id: number): void;
  /** Frees a frame nobody will use (ImageBitmap.close). */
  drop(frame: F): void;
  /** The worker cannot be used any more: lost a frame or failed in a row. */
  broken(why: 'lost' | 'errors'): void;
  /**
   * A pause between polls longer than this (the page was hidden, the loop
   * stopped between steps) makes a waiting reading stale: it is dropped,
   * and the in-flight frame's clock restarts (a frozen page is not a hung
   * worker).
   */
  staleGapMs?: number;
  /** A frame not back after this long: the worker is hung. */
  lostMs?: number;
  /** Failed frames in a row before giving the worker up. */
  maxErrors?: number;
}

/**
 * Backpressure: at most one frame is being taken or analysed at a time;
 * a poll while the worker is busy takes no new frame. Each poll returns
 * the reading that came back since the previous poll (null when none),
 * then sends the next frame, so the worker runs no faster than the loop
 * that polls it, and no frame is read twice.
 */
export function createFramePump<F>(o: PumpOptions<F>) {
  const staleGapMs = o.staleGapMs ?? 400;
  const lostMs = o.lostMs ?? 4000;
  const maxErrors = o.maxErrors ?? 3;
  let busy: { id: number; at: number; since: number } | null = null;
  let waiting: FreshReading<F> | null = null;
  let handed: F | null = null;
  let lastPoll = -Infinity;
  let nextId = 1;
  let errors = 0;
  let closed = false;

  const give = (why: 'lost' | 'errors') => {
    if (closed) return;
    close();
    o.broken(why);
  };

  function close() {
    closed = true;
    busy = null;
    if (waiting) o.drop(waiting.frame);
    if (handed) o.drop(handed);
    waiting = null;
    handed = null;
  }

  return {
    /**
     * `capture` takes the current frame, or returns null when there is
     * none yet (the video has not started).
     */
    poll(capture: () => Promise<F> | null): FreshReading<F> | null {
      if (closed) return null;
      const t = o.now();
      if (handed) o.drop(handed);
      handed = null;
      if (t - lastPoll > staleGapMs) {
        if (waiting) o.drop(waiting.frame);
        waiting = null;
        if (busy) busy.since = t;
      }
      lastPoll = t;
      if (busy && t - busy.since > lostMs) {
        give('lost');
        return null;
      }
      const out = waiting;
      waiting = null;
      if (!busy) {
        const taking = capture();
        if (taking) {
          const id = nextId++;
          busy = { id, at: t, since: t };
          taking.then(
            (frame) => {
              if (closed || busy?.id !== id) o.drop(frame);
              else o.send(frame, t, id);
            },
            () => {
              if (busy?.id === id) busy = null;
            },
          );
        }
      }
      if (out) handed = out.frame;
      return out;
    },
    /** The worker's reading of frame `id`, with the frame back. */
    deliver(id: number, reading: FaceReading, frame: F): void {
      if (closed || busy?.id !== id) {
        o.drop(frame);
        return;
      }
      const at = busy.at;
      busy = null;
      errors = 0;
      if (waiting) o.drop(waiting.frame);
      waiting = { reading, frame, at };
    },
    /** The worker could not read frame `id`. */
    fail(id: number, frame: F | null): void {
      if (frame) o.drop(frame);
      if (closed || busy?.id !== id) return;
      busy = null;
      errors += 1;
      if (errors >= maxErrors) give('errors');
    },
    get busy(): boolean {
      return busy !== null;
    },
    close,
  };
}

export type FramePump<F> = ReturnType<typeof createFramePump<F>>;
