import { describe, expect, test } from 'bun:test';
import { resetConfirmMatches, wipeConfirmMatches } from '../purgeCounts';

// purgeCountsByKind moved to @compass/contracts/limits (ADM2-34); its
// tests are packages/contracts/src/purgeKinds.test.ts.

describe('resetConfirmMatches (CMP-OPS-5)', () => {
  test('only the exact date confirms', () => {
    expect(resetConfirmMatches('2026-10-31', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches(' 2026-10-31 ', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches('2026-10-30', '2026-10-31')).toBe(false);
    expect(resetConfirmMatches('', '2026-10-31')).toBe(false);
    expect(resetConfirmMatches('', '')).toBe(false);
  });

  // DX-CAT-4: the iPhone's number pad has no "-". (Review TEST3-16: these
  // cases were in two describe blocks, some of them twice.)
  test('the digits of the date confirm it, with any separator or none', () => {
    expect(resetConfirmMatches('20261031', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches('2026/10/31', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches('2026.10.31', '2026-10-31')).toBe(true);
  });

  test('a digit short, or the digits in another order, does not', () => {
    expect(resetConfirmMatches('2026103', '2026-10-31')).toBe(false);
    expect(resetConfirmMatches('31102026', '2026-10-31')).toBe(false);
    expect(resetConfirmMatches('31.10.2026', '2026-10-31')).toBe(false);
  });
});

describe('wipeConfirmMatches (DX-CAT-17)', () => {
  test('the visible workspace name confirms, spaces around ignored', () => {
    expect(wipeConfirmMatches('Acme', 'Acme')).toBe(true);
    expect(wipeConfirmMatches(' Acme ', 'Acme')).toBe(true);
  });
  test('anything else does not', () => {
    expect(wipeConfirmMatches('default', 'Acme')).toBe(false);
    expect(wipeConfirmMatches('acme', 'Acme')).toBe(false);
    expect(wipeConfirmMatches('', '')).toBe(false);
  });
});
