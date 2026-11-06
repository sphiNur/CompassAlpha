import { describe, expect, test } from 'bun:test';
import { MATCH_THRESHOLD } from '../index';
import { faceInGrayZone, identify, spotCheck, SPOT_CHECK_EVERY, type KnownFace } from '../checks';

const unit = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
/** A vector at cosine `c` with unit(0). */
const at = (c: number) => [c, Math.sqrt(1 - c * c), 0, 0, 0, 0, 0, 0];

describe('spot check', () => {
  test('the same person, day and count always give the same answer', () => {
    for (let n = 0; n < 6; n++) {
      expect(spotCheck('m1', '2026-11-06', n)).toBe(spotCheck('m1', '2026-11-06', n));
    }
  });

  test('about one punch in three', () => {
    let hits = 0;
    const total = 3000;
    for (let i = 0; i < total; i++) if (spotCheck(`m${i}`, '2026-11-06', i % 4)) hits++;
    const rate = hits / total;
    expect(rate).toBeGreaterThan(1 / SPOT_CHECK_EVERY - 0.04);
    expect(rate).toBeLessThan(1 / SPOT_CHECK_EVERY + 0.04);
  });
});

describe('identify', () => {
  const known = (pairs: [string, number[]][]): KnownFace[] =>
    pairs.map(([name, feature]) => ({ memberId: name, name, features: [feature] }));

  test('the one clear best match over the line', () => {
    const who = identify(
      unit(0),
      known([
        ['A', unit(0)],
        ['B', unit(1)],
      ]),
    );
    expect(who?.memberId).toBe('A');
  });

  test('nobody when the best is under the match line', () => {
    expect(identify(unit(0), known([['A', at(MATCH_THRESHOLD - 0.01)]]))).toBeNull();
    expect(identify(unit(0), [])).toBeNull();
  });

  test('nobody when two people are too close to tell apart', () => {
    expect(
      identify(
        unit(0),
        known([
          ['A', at(0.8)],
          ['B', at(0.78)],
        ]),
      ),
    ).toBeNull();
    expect(
      identify(
        unit(0),
        known([
          ['A', at(0.8)],
          ['B', at(0.7)],
        ]),
      )?.memberId,
    ).toBe('A');
  });

  test('gray zone around the match line', () => {
    expect(faceInGrayZone(0.29)).toBe(false);
    expect(faceInGrayZone(0.36)).toBe(true);
    expect(faceInGrayZone(0.45)).toBe(false);
  });
});
