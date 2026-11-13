/** Review RUNWEB1-21 (2026-11-12): blocked storage must not break a screen. */
import { afterEach, describe, expect, it } from 'bun:test';
import { memoryStorage, throwingStorage } from '../../__tests__/helpers/storage';
import { readLocalPref, writeLocalPref } from '../localPref';

const g = globalThis as { window?: unknown };
const realWindow = g.window;

afterEach(() => {
  g.window = realWindow;
});

describe('local preferences', () => {
  it('saves and reads a value', () => {
    g.window = { localStorage: memoryStorage() };
    expect(readLocalPref('compass.test')).toBeNull();
    writeLocalPref('compass.test', 'byStore');
    expect(readLocalPref('compass.test')).toBe('byStore');
  });

  it('reads nothing and saves nothing where storage throws', () => {
    g.window = { localStorage: throwingStorage() };
    expect(readLocalPref('compass.test')).toBeNull();
    expect(() => writeLocalPref('compass.test', '1')).not.toThrow();
    // Touching localStorage itself throws in some WebViews.
    g.window = {
      get localStorage() {
        throw new Error('SecurityError');
      },
    };
    expect(readLocalPref('compass.test')).toBeNull();
    expect(() => writeLocalPref('compass.test', '1')).not.toThrow();
  });

  it('works without a window (tests, server)', () => {
    g.window = undefined;
    expect(readLocalPref('compass.test')).toBeNull();
    expect(() => writeLocalPref('compass.test', '1')).not.toThrow();
  });
});
