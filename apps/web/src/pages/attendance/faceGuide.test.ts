/**
 * Review TEST3-08 (2026-11-10): when the tracker may take a face photo had
 * no test. A photo is taken by the tracker, never by a button, so these
 * checks are all that stands between a bad frame and the server.
 */
import { describe, expect, test } from 'bun:test';
import type { FaceReading } from '../../lib/faceTracker';
import { HOLD, basicGuide, steadyCounter, type Guide } from './faceGuide';

/** One face, looking straight, close enough. */
const FACE: FaceReading = {
  count: 1,
  yaw: 0,
  pitch: 0.5,
  size: 0.4,
  cx: 0.5,
  cy: 0.5,
  blink: 0,
  jaw: 0,
};

describe('basicGuide', () => {
  test('one face close enough: hold still', () => {
    expect(basicGuide(FACE)).toBeNull();
  });

  test('no face, or a face the tracker cannot turn into a pose', () => {
    expect(basicGuide({ ...FACE, count: 0, yaw: null })).toBe('noFace');
    expect(basicGuide({ ...FACE, yaw: null })).toBe('noFace');
  });

  test('more than one face', () => {
    expect(basicGuide({ ...FACE, count: 2 })).toBe('manyFaces');
  });

  test('too far away, against the default or the given minimum', () => {
    expect(basicGuide({ ...FACE, size: 0.27 })).toBe('closer');
    expect(basicGuide({ ...FACE, size: 0.28 })).toBeNull();
    expect(basicGuide({ ...FACE, size: 0.3 }, 0.35)).toBe('closer');
    // No size reading is not a reason to stop.
    expect(basicGuide({ ...FACE, size: null })).toBeNull();
  });

  test('no face is said before many faces, and many before too far', () => {
    expect(basicGuide({ ...FACE, count: 0, yaw: null, size: 0.1 })).toBe('noFace');
    expect(basicGuide({ ...FACE, count: 3, size: 0.1 })).toBe('manyFaces');
  });
});

describe('steadyCounter', () => {
  const run = (guides: Array<Guide | null>, hold?: number) => {
    const steady = steadyCounter(hold);
    return guides.map((g) => steady(g));
  };

  test(`takes the frame on the ${HOLD}rd steady reading in a row`, () => {
    expect(HOLD).toBe(3);
    expect(run([null, null, null])).toEqual([false, false, true]);
  });

  test('any guide starts the count again', () => {
    expect(run([null, null, 'closer', null, null, null])).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  test('another hold length', () => {
    expect(run([null, null], 2)).toEqual([false, true]);
  });
});
