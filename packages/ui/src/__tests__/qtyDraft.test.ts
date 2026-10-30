import { describe, expect, it } from 'bun:test';
import { readQtyDraft } from '../qtyDraft';

// F13 / ORD-8 (2026-10-30): an emptied field, "abc" or "-3" all became
// "Set 0 kg" and tapping it wiped the line.
const range = { min: 0, max: 9999 };

describe('readQtyDraft', () => {
  it('refuses an empty field instead of reading it as 0', () => {
    expect(readQtyDraft('', range)).toEqual({ ok: false, reason: 'empty' });
    expect(readQtyDraft('   ', range)).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses text that is not a plain decimal', () => {
    for (const s of ['abc', '1.2.3', '0x10', '1e3', '--1', '.']) {
      expect(readQtyDraft(s, range)).toEqual({ ok: false, reason: 'notNumber' });
    }
  });

  it('refuses out-of-range values instead of clamping them', () => {
    expect(readQtyDraft('-3', range)).toEqual({ ok: false, reason: 'belowMin' });
    expect(readQtyDraft('10000', range)).toEqual({ ok: false, reason: 'aboveMax' });
    expect(readQtyDraft('0.5', { min: 1, max: 10 })).toEqual({ ok: false, reason: 'belowMin' });
  });

  it('keeps what was typed — no snap to the +/- step', () => {
    expect(readQtyDraft('0.3', range)).toEqual({ ok: true, value: 0.3 });
    expect(readQtyDraft('1.25', range)).toEqual({ ok: true, value: 1.25 });
    expect(readQtyDraft('2.0004', range)).toEqual({ ok: true, value: 2 });
    expect(readQtyDraft('.5', range)).toEqual({ ok: true, value: 0.5 });
    expect(readQtyDraft('7.', range)).toEqual({ ok: true, value: 7 });
  });

  it('a deliberate 0 is still allowed when the minimum is 0', () => {
    expect(readQtyDraft('0', range)).toEqual({ ok: true, value: 0 });
  });
});
