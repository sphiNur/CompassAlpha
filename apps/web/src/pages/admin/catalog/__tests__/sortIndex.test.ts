import { describe, expect, it } from 'bun:test';
import { readSortIndex } from '../sortIndex';

describe('readSortIndex (NEW-07)', () => {
  it('reads whole numbers, negative ones too', () => {
    expect(readSortIndex('100')).toBe(100);
    expect(readSortIndex('-5')).toBe(-5);
    expect(readSortIndex(' 7 ')).toBe(7);
    expect(readSortIndex('-1000000')).toBe(-1_000_000);
    expect(readSortIndex('1000000')).toBe(1_000_000);
  });

  it('reads nothing from what used to save as 0 or a cut-off number', () => {
    for (const text of ['', '-', '1.5', '1,5', '1e2', 'abc', '1000001', '-1000001']) {
      expect({ text, read: readSortIndex(text) }).toEqual({ text, read: null });
    }
  });
});
