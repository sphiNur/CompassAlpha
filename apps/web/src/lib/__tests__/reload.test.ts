import { describe, expect, it } from 'bun:test';
import { HIDDEN_BEFORE_AUTO_RELOAD_MS, mayAutoReload } from '../reload';

const idle = { openSheets: 0, mutationsInFlight: 0, queuedWrites: 0 };

describe('mayAutoReload', () => {
  it('never reloads while the app is on screen', () => {
    expect(mayAutoReload({ ...idle, hiddenForMs: null })).toBe(false);
  });

  it('does not treat a short trip to another app as having left', () => {
    expect(mayAutoReload({ ...idle, hiddenForMs: 30_000 })).toBe(false);
    expect(mayAutoReload({ ...idle, hiddenForMs: HIDDEN_BEFORE_AUTO_RELOAD_MS - 1 })).toBe(false);
  });

  it('reloads once the app has been in the background long enough with nothing at stake', () => {
    expect(mayAutoReload({ ...idle, hiddenForMs: HIDDEN_BEFORE_AUTO_RELOAD_MS })).toBe(true);
  });

  it('holds off while there is anything to lose', () => {
    const hiddenForMs = HIDDEN_BEFORE_AUTO_RELOAD_MS * 10;
    expect(mayAutoReload({ ...idle, hiddenForMs, openSheets: 1 })).toBe(false);
    expect(mayAutoReload({ ...idle, hiddenForMs, mutationsInFlight: 1 })).toBe(false);
    expect(mayAutoReload({ ...idle, hiddenForMs, queuedWrites: 1 })).toBe(false);
  });
});
