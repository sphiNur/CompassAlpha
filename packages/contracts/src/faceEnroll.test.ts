/**
 * Review ATT-27: the enrollment's poses and refusal reasons are one list,
 * shared by the server and the phone. The request schema names its photos
 * by hand, so it is held to that list here.
 */
import { describe, expect, test } from 'bun:test';
import { AttendanceFaceEnrollInputSchema } from './schemas/attendance';
import {
  ENROLL_POSES,
  ENROLL_PROBLEMS,
  isEnrollPose,
  isEnrollProblem,
  REQUIRED_ENROLL_POSES,
} from './schemas/faceEnroll';

describe('face enrollment poses and reasons', () => {
  const photos = AttendanceFaceEnrollInputSchema.shape.photos.shape;

  test('the request takes a photo for every pose, and only those', () => {
    expect(Object.keys(photos).sort()).toEqual([...ENROLL_POSES].sort());
  });

  test('the request requires exactly the required poses', () => {
    const required = Object.entries(photos)
      .filter(([, schema]) => !schema.isOptional())
      .map(([pose]) => pose);
    expect(required.sort()).toEqual([...REQUIRED_ENROLL_POSES].sort());
  });

  test('the guards know the lists and nothing else', () => {
    expect(ENROLL_POSES.every(isEnrollPose)).toBe(true);
    expect(ENROLL_PROBLEMS.every(isEnrollProblem)).toBe(true);
    expect(isEnrollPose('sideways')).toBe(false);
    expect(isEnrollProblem('tooOld')).toBe(false);
    expect(isEnrollProblem('front')).toBe(false);
  });
});
