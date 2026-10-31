import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { remainingAfterPause } from '../components/Toast';

describe('toast pause (A11Y-6)', () => {
  test('keeps the time that was left', () => {
    expect(remainingAfterPause(10_000, 6_000)).toBe(4_000);
  });

  test('never resumes with less than the minimum', () => {
    expect(remainingAfterPause(10_000, 9_500)).toBe(2_000);
    expect(remainingAfterPause(10_000, 12_000, 1_500)).toBe(1_500);
  });

  test('an action toast pauses on pointer and on focus', () => {
    const src = readFileSync(join(import.meta.dir, '../components/Toast.tsx'), 'utf8');
    for (const handler of ['onPointerEnter', 'onPointerLeave', 'onFocus', 'onBlur']) {
      expect({ handler, wired: src.includes(`${handler}=`) }).toEqual({ handler, wired: true });
    }
  });
});
