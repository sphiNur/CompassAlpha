import { describe, expect, test } from 'bun:test';
import { decodeJpeg, detect, loadEngine, similarity } from '../services/face/pipeline';
import { cosine, faceFeature, setFaceEngineForTests } from '../services/face';

describe('face pipeline', () => {
  test('similarity recovers a rotation, scale and shift', () => {
    const src: [number, number][] = [
      [10, 20],
      [40, 22],
      [25, 35],
      [12, 50],
      [38, 52],
    ];
    const angle = 0.3;
    const k = 1.7;
    const [a, b] = [k * Math.cos(angle), k * Math.sin(angle)];
    const dst = src.map(([x, y]) => [a * x - b * y + 5, b * x + a * y - 3] as [number, number]);
    const t = similarity(src, dst);
    expect(t.a).toBeCloseTo(a, 6);
    expect(t.b).toBeCloseTo(b, 6);
    expect(t.tx).toBeCloseTo(5, 6);
    expect(t.ty).toBeCloseTo(-3, 6);
  });

  test('the models load and find no face in a blank picture', async () => {
    const engine = await loadEngine();
    const blank = { width: 320, height: 240, data: new Uint8Array(320 * 240 * 4).fill(128) };
    expect(await detect(engine.detector, blank)).toEqual([]);
  }, 30_000);

  test('a JPEG decodes', () => {
    // 1×1 white JPEG.
    const b64 =
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
    const img = decodeJpeg(new Uint8Array(Buffer.from(b64, 'base64')));
    expect([img.width, img.height]).toEqual([1, 1]);
  });

  test('a failing engine gives null, not an error', async () => {
    setFaceEngineForTests(() => Promise.reject(new Error('boom')));
    expect(await faceFeature(new Uint8Array([1]))).toBeNull();
    setFaceEngineForTests(null);
  });

  test('cosine', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0.6, 0.8], [0.8, 0.6])).toBeCloseTo(0.96, 12);
  });

  test('cosine is a plain dot product over the shorter feature', () => {
    // Review TEST1-20. It divides by nothing: it is the cosine only for
    // features of length 1, which embed() makes them. A longer vector
    // scores higher.
    expect(cosine([2, 0], [3, 0])).toBe(6);
    // Features of different lengths are not refused: the extra values are
    // left out. An empty feature matches nothing.
    expect(cosine([1, 0, 5], [1, 0])).toBe(1);
    expect(cosine([], [1, 0])).toBe(0);
  });
});
