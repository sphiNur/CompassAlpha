/**
 * Turning a Face Landmarker result into a FaceReading: the pure part of
 * the face tracker, shared by the page (faceTracker.ts) and its worker
 * (faceWorker.ts). Review MWD-05 (modern-web-guidance: performance): it
 * moved out of faceTracker.ts so the worker does not pull in the page's
 * asset URLs; faceTracker.ts still exports all of it.
 */

export interface FaceReading {
  /** Faces in the frame. */
  count: number;
  /**
   * The largest face's head turn, as the server measures it: the nose's
   * offset from the eyes' midpoint in eye distances, positive when the
   * person turned to their own left (unmirrored frame). Null without a face.
   */
  yaw: number | null;
  /**
   * The nose between the eyes and the mouth, top to bottom: about 0.5
   * looking straight, smaller with the chin up, larger with it down.
   */
  pitch: number | null;
  /** The face's width as a share of the frame's. */
  size: number | null;
  /** The face box's centre, 0–1 across and down the (unmirrored) frame. */
  cx: number | null;
  cy: number | null;
  /** How closed the eyes are, 0 (open) – 1 (shut): both eyes' blendshape, averaged. */
  blink: number | null;
  /** How open the mouth is, 0 (shut) – 1 (wide): the jawOpen blendshape. */
  jaw: number | null;
}

type Point = { x: number; y: number };

/** yaw from two eyes and the nose tip, in pixels. */
export function yawFrom(eyeA: Point, eyeB: Point, nose: Point): number {
  const dist = Math.hypot(eyeB.x - eyeA.x, eyeB.y - eyeA.y) || 1;
  return (nose.x - (eyeA.x + eyeB.x) / 2) / dist;
}

/** pitch from two eyes, the nose tip and the mouth, in pixels. */
export function pitchFrom(eyeA: Point, eyeB: Point, nose: Point, mouth: Point): number {
  const eyes = (eyeA.y + eyeB.y) / 2;
  const span = mouth.y - eyes || 1;
  return (nose.y - eyes) / span;
}

export const NONE = {
  yaw: null,
  pitch: null,
  size: null,
  cx: null,
  cy: null,
  blink: null,
  jaw: null,
} as const;

/**
 * Face mesh points used for the turn and tilt: the corners of each eye
 * (their midpoint is the eye), the nose tip, the mouth corners.
 */
export const MESH = {
  eyeA: [33, 133],
  eyeB: [362, 263],
  nose: 1,
  mouth: [61, 291],
} as const;

type Mark = { x: number; y: number };

/** A FaceReading from one face's mesh (normalised points) in a w×h frame. */
export function readMesh(
  marks: readonly Mark[],
  w: number,
  h: number,
  count: number,
  shapes: { blink: number | null; jaw: number | null } = { blink: null, jaw: null },
): FaceReading {
  if (marks.length < 468) return { count, ...NONE };
  const px = (i: number) => ({ x: marks[i]!.x * w, y: marks[i]!.y * h });
  const mid = ([a, b]: readonly [number, number]) => {
    const p = px(a);
    const q = px(b);
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  };
  const eyeA = mid(MESH.eyeA);
  const eyeB = mid(MESH.eyeB);
  const nose = px(MESH.nose);
  const mouth = mid(MESH.mouth);
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const m of marks) {
    if (m.x < minX) minX = m.x;
    if (m.x > maxX) maxX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.y > maxY) maxY = m.y;
  }
  return {
    count,
    yaw: yawFrom(eyeA, eyeB, nose),
    pitch: pitchFrom(eyeA, eyeB, nose, mouth),
    size: maxX - minX,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    blink: shapes.blink,
    jaw: shapes.jaw,
  };
}

type Shape = { categoryName: string; score: number };

/** The blink and jaw-open scores from one face's blendshapes. */
export function readShapes(shapes: readonly Shape[] | undefined): {
  blink: number | null;
  jaw: number | null;
} {
  if (!shapes || shapes.length === 0) return { blink: null, jaw: null };
  const score = (name: string) => shapes.find((x) => x.categoryName === name)?.score ?? null;
  const l = score('eyeBlinkLeft');
  const r = score('eyeBlinkRight');
  return { blink: l !== null && r !== null ? (l + r) / 2 : null, jaw: score('jawOpen') };
}

/** The part of a FaceLandmarkerResult the reading uses. */
export interface LandmarkerOutput {
  faceLandmarks: readonly (readonly Mark[])[];
  faceBlendshapes?: readonly { categories: readonly Shape[] }[];
}

/** The reading of the largest face in a w×h frame's landmarker result. */
export function readResult(result: LandmarkerOutput, w: number, h: number): FaceReading {
  const faces = result.faceLandmarks;
  if (faces.length === 0) return { count: 0, ...NONE };
  const width = (f: readonly Mark[]) =>
    Math.max(...f.map((m) => m.x)) - Math.min(...f.map((m) => m.x));
  let best = 0;
  faces.forEach((f, i) => {
    if (width(f) > width(faces[best]!)) best = i;
  });
  const shapes = readShapes(result.faceBlendshapes?.[best]?.categories);
  return readMesh(faces[best]!, w, h, faces.length, shapes);
}

/** The landmarker's settings, on the page and in the worker alike. */
export const LANDMARKER_OPTIONS = {
  runningMode: 'VIDEO',
  // Two, to notice a second person in the frame.
  numFaces: 2,
  minFaceDetectionConfidence: 0.6,
  minFacePresenceConfidence: 0.6,
  minTrackingConfidence: 0.5,
  // Blink and open mouth (2026-11-07).
  outputFaceBlendshapes: true,
} as const;
