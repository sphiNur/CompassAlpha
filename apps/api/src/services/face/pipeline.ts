/**
 * Face pipeline (attendance face check, 2026-11-05), run in the face
 * worker: JPEG → YuNet (face box + 5 landmarks) → align to SFace's
 * 112×112 template → SFace (128-d feature, L2-normalised).
 * Liveness (2026-11-06): head turn from the landmarks (`yaw`) and the
 * MiniFASNet pair's real-face probability (`real`).
 * Enrollment (2026-11-06): how usable the photo is (`quality`): how many
 * faces, how big, how bright and how sharp.
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

/**
 * How far the head is turned: the nose's offset from the midpoint of the
 * eyes, in eye distances. 0 looking at the camera; positive when the
 * nose is to the right in the picture (unmirrored front camera: the
 * person turned to their own left). Around ±0.5 for a clear turn.
 */
export function yawOf(face: Face): number {
  const [e1, e2, nose] = face.landmarks as [[number, number], [number, number], [number, number]];
  const dist = Math.hypot(e2[0] - e1[0], e2[1] - e1[1]) || 1;
  return (nose[0] - (e1[0] + e2[0]) / 2) / dist;
}

/** MiniFASNet input: the box widened by `scale`, 80×80, BGR 0–255 (Silent-Face). */
export function spoofCrop(img: Image, face: Face, scale0: number): Float32Array {
  const [x, y, bw, bh] = face.box;
  const scale = Math.min((img.height - 1) / bh, (img.width - 1) / bw, scale0);
  const nw = bw * scale;
  const nh = bh * scale;
  const cx = x + bw / 2;
  const cy = y + bh / 2;
  const x1 = Math.max(0, Math.floor(cx - nw / 2));
  const y1 = Math.max(0, Math.floor(cy - nh / 2));
  const x2 = Math.min(img.width - 1, Math.floor(cx + nw / 2));
  const y2 = Math.min(img.height - 1, Math.floor(cy + nh / 2));
  const w = x2 - x1 + 1;
  const h = y2 - y1 + 1;
  const plane = 80 * 80;
  const out = new Float32Array(3 * plane);
  for (let j = 0; j < 80; j++) {
    for (let i = 0; i < 80; i++) {
      const sx = x1 + Math.min(w - 1, Math.max(0, ((i + 0.5) * w) / 80 - 0.5));
      const sy = y1 + Math.min(h - 1, Math.max(0, ((j + 0.5) * h) / 80 - 0.5));
      const k = j * 80 + i;
      out[k] = sample(img, sx, sy, 2);
      out[plane + k] = sample(img, sx, sy, 1);
      out[2 * plane + k] = sample(img, sx, sy, 0);
    }
  }
  return out;
}

/** Real-face probability, the two models averaged (class 1 = real). */
async function realness(spoof: Engine['spoof'], img: Image, face: Face): Promise<number> {
  let real = 0;
  for (const { session, scale } of spoof) {
    const out = await session.run({
      [session.inputNames[0]!]: new ort.Tensor(
        'float32',
        spoofCrop(img, face, scale),
        [1, 3, 80, 80],
      ),
    });
    const logits = Array.from(out[session.outputNames[0]!]!.data as Float32Array);
    const max = Math.max(...logits);
    const e = logits.map((v) => Math.exp(v - max));
    real += e[1]! / e.reduce((a, b) => a + b, 0);
  }
  return real / spoof.length;
}

export interface Engine {
  detector: ort.InferenceSession;
  recognizer: ort.InferenceSession;
  spoof: { session: ort.InferenceSession; scale: number }[];
}

const MODELS = new URL('../../../models/face/', import.meta.url);

export async function loadEngine(): Promise<Engine> {
  const read = async (name: string) => new Uint8Array(await readFile(new URL(name, MODELS)));
  const options = { logSeverityLevel: 3 as const };
  const [detector, recognizer, v2, v1se] = await Promise.all([
    ort.InferenceSession.create(await read('face_detection_yunet_2023mar.onnx'), options),
    ort.InferenceSession.create(await read('face_recognition_sface_2021dec_int8.onnx'), options),
    ort.InferenceSession.create(await read('MiniFASNetV2.onnx'), options),
    ort.InferenceSession.create(await read('MiniFASNetV1SE.onnx'), options),
  ]);
  return {
    detector,
    recognizer,
    spoof: [
      { session: v2, scale: 2.7 },
      { session: v1se, scale: 4.0 },
    ],
  };
}

/**
 * How the nose sits between the eyes and the mouth, top to bottom: about
 * 0.5 looking straight; smaller with the chin up, larger with it down.
 */
export function pitchOf(face: Face): number {
  const [e1, e2, nose, m1, m2] = face.landmarks as [number, number][];
  const eyes = (e1![1] + e2![1]) / 2;
  const mouth = (m1![1] + m2![1]) / 2;
  const span = mouth - eyes || 1;
  return (nose![1] - eyes) / span;
}

/** Mean brightness (0–255) inside the face box. */
export function lightOf(img: Image, face: Face): number {
  const [x, y, w, h] = face.box;
  let sum = 0;
  let n = 0;
  for (let j = 0; j < 24; j++) {
    for (let i = 0; i < 24; i++) {
      const sx = Math.min(img.width - 1, Math.max(0, Math.floor(x + ((i + 0.5) * w) / 24)));
      const sy = Math.min(img.height - 1, Math.max(0, Math.floor(y + ((j + 0.5) * h) / 24)));
      const k = (sy * img.width + sx) * 4;
      sum += 0.299 * img.data[k]! + 0.587 * img.data[k + 1]! + 0.114 * img.data[k + 2]!;
      n++;
    }
  }
  return sum / n;
}

/** Sharpness: variance of the Laplacian over the aligned 112×112 face. */
export function sharpOf(aligned: Float32Array): number {
  const plane = 112 * 112;
  const gray = (i: number) => (aligned[i]! + aligned[plane + i]! + aligned[2 * plane + i]!) / 3;
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 1; y < 111; y++) {
    for (let x = 1; x < 111; x++) {
      const i = y * 112 + x;
      const lap = gray(i - 112) + gray(i + 112) + gray(i - 1) + gray(i + 1) - 4 * gray(i);
      sum += lap;
      sq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}

export interface FaceQuality {
  /** Faces in the photo. */
  faces: number;
  /** The face's width as a share of the photo's. */
  size: number;
  /** 0–255. */
  light: number;
  sharp: number;
  pitch: number;
}

export type FaceResult =
  | { found: false }
  | {
      found: true;
      score: number;
      feature: number[];
      yaw: number;
      real: number;
      /** Not set by test stubs. */
      quality?: FaceQuality;
    };

/** The largest face's feature, or none found. */
export async function faceFeature(engine: Engine, bytes: Uint8Array): Promise<FaceResult> {
  const img = decodeJpeg(bytes);
  const faces = await detect(engine.detector, img);
  if (faces.length === 0) return { found: false };
  const face = faces.reduce((best, f) =>
    f.box[2] * f.box[3] > best.box[2] * best.box[3] ? f : best,
  );
  const aligned = align(img, face);
  return {
    found: true,
    score: face.score,
    feature: await embed(engine.recognizer, aligned),
    yaw: yawOf(face),
    real: await realness(engine.spoof, img, face),
    quality: {
      faces: faces.length,
      size: face.box[2] / img.width,
      light: lightOf(img, face),
      sharp: sharpOf(aligned),
      pitch: pitchOf(face),
    },
  };
}
