/**
 * DX-ORD-1 (2026-11-01): a realtime refetch must not land among taps the
 * Order page has not sent yet — it overwrote them and a step was lost.
 */
import { describe, expect, it } from 'bun:test';
import { shouldDeferInvalidate } from '../useRealtime';
import { hasLocalWrites, registerLocalWrites } from '../../lib/localWrites';

describe('shouldDeferInvalidate', () => {
  it('runs at once when nothing is pending', () => {
    expect(shouldDeferInvalidate(false, false, 0)).toBe(false);
  });

  it('waits for running mutations, up to 2.5 s', () => {
    expect(shouldDeferInvalidate(true, false, 1_000)).toBe(true);
    expect(shouldDeferInvalidate(true, false, 2_600)).toBe(false);
  });

  it('waits for unsent local taps even with no mutation running', () => {
    expect(shouldDeferInvalidate(false, true, 0)).toBe(true);
    expect(shouldDeferInvalidate(false, true, 5_000)).toBe(true);
  });

  it('gives up on local writes after 10 s so data cannot freeze', () => {
    expect(shouldDeferInvalidate(false, true, 10_001)).toBe(false);
  });
});

describe('local write probes', () => {
  it('reports a registered screen holding writes until it unregisters', () => {
    let pending = true;
    const off = registerLocalWrites(() => pending);
    expect(hasLocalWrites()).toBe(true);
    pending = false;
    expect(hasLocalWrites()).toBe(false);
    pending = true;
    off();
    expect(hasLocalWrites()).toBe(false);
  });

  it('a throwing probe does not block refreshes', () => {
    const off = registerLocalWrites(() => {
      throw new Error('boom');
    });
    expect(hasLocalWrites()).toBe(false);
    off();
  });
});
