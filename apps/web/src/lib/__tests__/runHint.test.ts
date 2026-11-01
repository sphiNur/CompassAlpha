import { describe, expect, test } from 'bun:test';
import { RUN_HINT_KEY, readRunHint, saveRunHint } from '../runHint';

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('run hint (DX-PFE-3: run.get without waiting for run.list)', () => {
  test('remembers the run on screen for its owner only', () => {
    const s = memory();
    saveRunHint(s, 'user-1:org-1', 'run-a');
    expect(readRunHint(s, 'user-1:org-1')).toBe('run-a');
    // Another person, or the same person in another organisation.
    expect(readRunHint(s, 'user-2:org-1')).toBeNull();
    expect(readRunHint(s, 'user-1:org-2')).toBeNull();
  });

  test('no active run forgets it', () => {
    const s = memory();
    saveRunHint(s, 'u:o', 'run-a');
    saveRunHint(s, 'u:o', null);
    expect(s.map.has(RUN_HINT_KEY)).toBe(false);
    expect(readRunHint(s, 'u:o')).toBeNull();
  });

  test('nothing is written without an owner, and junk reads as no hint', () => {
    const s = memory();
    saveRunHint(s, null, 'run-a');
    expect(s.map.size).toBe(0);
    s.map.set(RUN_HINT_KEY, '{oops');
    expect(readRunHint(s, 'u:o')).toBeNull();
    s.map.set(RUN_HINT_KEY, JSON.stringify({ owner: 'u:o', runId: 42 }));
    expect(readRunHint(s, 'u:o')).toBeNull();
    expect(readRunHint(null, 'u:o')).toBeNull();
  });

  test('a storage that throws is ignored', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveRunHint(broken, 'u:o', 'run-a')).not.toThrow();
    expect(readRunHint(broken, 'u:o')).toBeNull();
  });
});
