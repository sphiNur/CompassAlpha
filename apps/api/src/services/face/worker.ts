/**
 * Face worker thread: keeps the models loaded and answers one photo at a
 * time, so ~0.5 s of inference never blocks the API's event loop.
 */
import { faceFeature, loadEngine, type Engine } from './pipeline';

declare const self: Worker;

let engine: Promise<Engine> | null = null;

self.onmessage = async (event: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
  const { id, bytes } = event.data;
  try {
    engine ??= loadEngine();
    const result = await faceFeature(await engine, bytes);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message ?? 'face pipeline failed' });
  }
};
