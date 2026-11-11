import { describe, expect, test } from 'bun:test';
import type { CanonicalUnit } from '@compass/contracts';
import {
  cleanExtraRows,
  extraLinesToSave,
  isInvalidExtraRow,
  wholeNumberRequired,
  type ExtraDraft,
  type ExtraLine,
} from '../extraRows';

const row = (name: string, qty: string, unit: string, note?: string): ExtraDraft => ({
  name,
  qty,
  unit,
  ...(note === undefined ? {} : { note }),
});
/** A row as a save sends it. */
const line = (name: string, qty: string, unit: CanonicalUnit, note?: string): ExtraLine => ({
  name,
  qty,
  unit,
  ...(note === undefined ? {} : { note }),
});

// ORD-13 (2026-11-11): a unit written before M3.34 ("kgs", "公斤") used to
// be shown as kg, and saving the list again made it kg.
describe('a unit that is not on the list', () => {
  test('is shown as written', () => {
    expect(cleanExtraRows([row('Lavash', '2', 'kgs')])).toEqual([row('Lavash', '2', 'kgs')]);
  });

  test('holds the whole save back instead of changing or dropping the row', () => {
    expect(extraLinesToSave([row('Lavash', '2', 'kgs'), row('Salt', '1', 'kg')])).toBeNull();
    expect(isInvalidExtraRow(row('Lavash', '2', '公斤'))).toBe(true);
  });

  test('on a row not filled in yet is no reason to wait', () => {
    expect(extraLinesToSave([row('', '1', 'kgs'), row('Salt', '1', 'kg')])).toEqual([
      line('Salt', '1', 'kg'),
    ]);
    expect(isInvalidExtraRow(row(' ', '1', 'kgs'))).toBe(false);
  });
});

describe('the rows a save sends', () => {
  test('are named, trimmed and carry a quantity the server takes', () => {
    expect(
      extraLinesToSave([
        row('  Salt ', ' 1.5 ', 'kg', '  coarse  '),
        row('Pepper', '0', 'kg'),
        row('Oil', '1.2345', 'L'),
        row('Eggs', '', 'pcs'),
        row('Foil', '2', 'roll', '   '),
      ]),
    ).toEqual([line('Salt', '1.5', 'kg', 'coarse'), line('Foil', '2', 'roll')]);
  });

  test('leave out a fraction of a counted unit, box included', () => {
    expect(
      extraLinesToSave([
        row('Eggs', '1.5', 'box'),
        row('Cups', '2.5', 'pack'),
        row('Milk', '1.5', 'L'),
      ]),
    ).toEqual([line('Milk', '1.5', 'L')]);
    expect(wholeNumberRequired(row('Eggs', '1.5', 'box'))).toBe(true);
    expect(wholeNumberRequired(row('Eggs', '2', 'box'))).toBe(false);
    expect(isInvalidExtraRow(row('Eggs', '1.5', 'box'))).toBe(true);
  });

  test('a quantity past the server bound is flagged before saving', () => {
    expect(isInvalidExtraRow(row('Rice', '1000000', 'kg'))).toBe(true);
    expect(isInvalidExtraRow(row('Rice', '999999', 'kg'))).toBe(false);
  });
});
