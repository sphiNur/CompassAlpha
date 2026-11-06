import { describe, expect, test } from 'bun:test';
import { headDirection, poseAt, RING, TICKS, ticksNear, ticksOf } from './faceRing';

describe('face ring', () => {
  test('the person turning to their own right lights the screen right', () => {
    // yaw < 0: turned to their own right (the server's "right" pose).
    const d = headDirection(-0.4, 0.5, 0.5);
    expect(Math.round(d.angle)).toBe(0);
    expect(poseAt(d)).toBe('right');
    expect(poseAt(headDirection(0.4, 0.5, 0.5))).toBe('left');
  });

  test('chin up is up, chin down is down', () => {
    expect(poseAt(headDirection(0, 0.38, 0.5))).toBe('up');
    expect(poseAt(headDirection(0, 0.62, 0.5))).toBe('down');
  });

  test('diagonals combine a half turn and a half tilt', () => {
    expect(poseAt(headDirection(-0.27, 0.42, 0.5))).toBe('upright');
    expect(poseAt(headDirection(0.27, 0.58, 0.5))).toBe('downleft');
  });

  test('not far enough, or between two directions, is nothing', () => {
    expect(poseAt(headDirection(-0.2, 0.5, 0.5))).toBeNull();
    // 22.5° off every direction.
    const between = headDirection(
      -0.35 * Math.cos(Math.PI / 8),
      0.5 - 0.1 * Math.sin(Math.PI / 8),
      0.5,
    );
    expect(between.reach).toBeCloseTo(1);
    expect(poseAt(between)).toBeNull();
  });

  test('the eight directions fill the whole ring', () => {
    const lit = new Set(RING.flatMap((r) => ticksOf(r.pose)));
    expect(lit.size).toBe(TICKS);
    expect(ticksNear(0, 6)).toEqual([0, 1, 59]);
  });
});
