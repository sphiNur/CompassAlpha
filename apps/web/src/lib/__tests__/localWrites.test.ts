/**
 * DX-ORD-1 (2026-11-01): a realtime refetch must not land among taps the
 * Order page has not sent yet — it overwrote them and a step was lost.
 * The screens report their unsent taps here; how long the refetch waits
 * for them is tested with the rest of useRealtime (realtimeLive.test.ts).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { hasLocalWrites, registerLocalWrites } from '../localWrites';

describe('local write probes', () => {
  // TEST3-07: the probes are module state shared with every other test file.
  // One left behind by a failed assertion would hold every later refresh back.
  const offs: Array<() => void> = [];
  const register = (probe: () => boolean) => {
    const off = registerLocalWrites(probe);
    offs.push(off);
    return off;
  };
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  it('reports a registered screen holding writes until it unregisters', () => {
    let pending = true;
    const off = register(() => pending);
    expect(hasLocalWrites()).toBe(true);
    pending = false;
    expect(hasLocalWrites()).toBe(false);
    pending = true;
    off();
    expect(hasLocalWrites()).toBe(false);
  });

  it('a throwing probe does not block refreshes', () => {
    const off = register(() => {
      throw new Error('boom');
    });
    expect(hasLocalWrites()).toBe(false);
    off();
  });
});
