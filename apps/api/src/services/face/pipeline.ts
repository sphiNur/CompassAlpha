/**
 * Face pipeline (attendance face check, 2026-11-05), run in the face
 * worker: JPEG → YuNet (face box + 5 landmarks) → align to SFace's
 * 112×112 template → SFace (128-d feature, L2-normalised).
 * Models and licenses: apps/api/models/face/README.md.
 */
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web';
import jpeg from 'jpeg-js';

ort.env.wasm.numThreads = 1;

export interface Image {
  width: number;
  height: number;
  /** RGBA. */
  data: Uint8Array;
}

export interface Face {
  /** x, y, width, height in image pixels. */
  box: [number, number, number, number];
  score: number;
  /** Right eye, left eye, nose tip, right and left mouth corner (image coordinates). */
  landmarks: [number, number][];
}

export function decodeJpeg(bytes: Uint8Array): Image {
  const img = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxMemoryUsageInMB: 256,
    maxResolutionInMP: 30,
  });
  return { width: img.width, height: img.height, data: img.data as Uint8Array };
}

function sample(img: Image, x: number, y: number, ch: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const px = (xx: number, yy: number) =>
    xx < 0 || yy < 0 || xx >= img.width || yy >= img.height
      ? 0
      : img.data[(yy * img.width + xx) * 4 + ch]!;
  return (
    px(x0, y0) * (1 - fx) * (1 - fy) +
    px(x0 + 1, y0) * fx * (1 - fy) +
    px(x0, y0 + 1) * (1 - fx) * fy +
    px(x0 + 1, y0 + 1) * fx * fy
  );
}

const SIZE = 640;
const STRIDES = [8, 16, 32] as const;
const SCORE_MIN = 0.8;

function iou(a: Face, b: Face): number {
  const [ax, ay, aw, ah] = a.box;
  const [bx, by, bw, bh] = b.box;
  const w = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const h = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  return (w * h) / (aw * ah + bw * bh - w * h);
}

/** Faces in the image, best first (YuNet 2023mar, as OpenCV decodes it). */
export async function detect(session: ort.InferenceSession, img: Image): Promise<Face[]> {
  const scale = Math.min(1, SIZE / Math.max(img.width, img.height));
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const sy = (y + 0.5) / scale - 0.5;
      const i = y * SIZE + x;
      // BGR, 0–255, no normalisation.
      input[i] = sample(img, sx, sy, 2);
      input[plane + i] = sample(img, sx, sy, 1);
      input[2 * plane + i] = sample(img, sx, sy, 0);
    }
  }
  const out = await session.run({
    [session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]),
  });
  const faces: Face[] = [];
  for (const s of STRIDES) {
    const cols = SIZE / s;
    const cls = out[`cls_${s}`]!.data as Float32Array;
    const obj = out[`obj_${s}`]!.data as Float32Array;
    const bbox = out[`bbox_${s}`]!.data as Float32Array;
    const kps = out[`kps_${s}`]!.data as Float32Array;
    for (let idx = 0; idx < cls.length; idx++) {
      const score = Math.sqrt(
        Math.min(1, Math.max(0, cls[idx]!)) * Math.min(1, Math.max(0, obj[idx]!)),
      );
      if (score < SCORE_MIN) continue;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const cx = (c + bbox[idx * 4]!) * s;
      const cy = (r + bbox[idx * 4 + 1]!) * s;
      const bw = Math.exp(bbox[idx * 4 + 2]!) * s;
      const bh = Math.exp(bbox[idx * 4 + 3]!) * s;
      const landmarks: [number, number][] = [];
      for (let n = 0; n < 5; n++) {
        landmarks.push([
          ((kps[idx * 10 + 2 * n]! + c) * s) / scale,
          ((kps[idx * 10 + 2 * n + 1]! + r) * s) / scale,
        ]);
      }
      faces.push({
        box: [(cx - bw / 2) / scale, (cy - bh / 2) / scale, bw / scale, bh / scale],
        score,
        landmarks,
      });
    }
  }
  faces.sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const f of faces) if (kept.every((k) => iou(k, f) < 0.3)) kept.push(f);
  return kept;
}

/** Where SFace expects the five landmarks in its 112×112 input. */
const TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Least-squares similarity transform src → dst (rotation, uniform scale,
 * shift): u = a·x − b·y + tx, v = b·x + a·y + ty.
 */
export function similarity(src: readonly [number, number][], dst: readonly [number, number][]) {
  const n = src.length;
  let mx = 0;
  let my = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < n; i++) {
    mx += src[i]![0];
    my += src[i]![1];
    nx += dst[i]![0];
    ny += dst[i]![1];
  }
  mx /= n;
  my /= n;
  nx /= n;
  ny /= n;
  let dot = 0;
  let cross = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i]![0] - mx;
    const y = src[i]![1] - my;
    const u = dst[i]![0] - nx;
    const v = dst[i]![1] - ny;
    dot += x * u + y * v;
    cross += x * v - y * u;
    norm += x * x + y * y;
  }
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) };
}

/** The face warped onto SFace's template: RGB, 0–255, NCHW. */
export function align(img: Image, face: Face): Float32Array {
  const { a, b, tx, ty } = similarity(face.landmarks, TEMPLATE);
  const d = a * a + b * b;
  const plane = 112 * 112;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 112; x++) {
      const u = x - tx;
      const v = y - ty;
      const sx = (a * u + b * v) / d;
      const sy = (-b * u + a * v) / d;
      const i = y * 112 + x;
      out[i] = sample(img, sx, sy, 0);
      out[plane + i] = sample(img, sx, sy, 1);
      out[2 * plane + i] = sample(img, sx, sy, 2);
    }
  }
  return out;
}

export async function embed(session: ort.InferenceSession, aligned: Float32Array) {
  const out = await session.run({
    [session.inputNames[0]!]: new ort.Tensor('float32', aligned, [1, 3, 112, 112]),
  });
  const v = out[session.outputNames[0]!]!.data as Float32Array;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

export interface Engine {
  detector: ort.InferenceSession;
  recognizer: ort.InferenceSession;
}

const MODELS = new URL('../../../models/face/', import.meta.url);

export async function loadEngine(): Promise<Engine> {
  const read = async (name: string) => new Uint8Array(await readFile(new URL(name, MODELS)));
  const options = { logSeverityLevel: 3 as const };
  const [detector, recognizer] = await Promise.all([
    ort.InferenceSession.create(await read('face_detection_yunet_2023mar.onnx'), options),
    ort.InferenceSession.create(await read('face_recognition_sface_2021dec_int8.onnx'), options),
  ]);
  return { detector, recognizer };
}

export type FaceResult = { found: false } | { found: true; score: number; feature: number[] };

/** The largest face's feature, or none found. */
export async function faceFeature(engine: Engine, bytes: Uint8Array): Promise<FaceResult> {
  const img = decodeJpeg(bytes);
  const faces = await detect(engine.detector, img);
  if (faces.length === 0) return { found: false };
  const face = faces.reduce((best, f) =>
    f.box[2] * f.box[3] > best.box[2] * best.box[3] ? f : best,
  );
  return {
    found: true,
    score: face.score,
    feature: await embed(engine.recognizer, align(img, face)),
  };
}
