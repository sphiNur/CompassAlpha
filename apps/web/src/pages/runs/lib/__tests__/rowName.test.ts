/**
 * Review RUNWEB1-09: the run rows' name, two lines (UI-4), the same
 * object each time so the memo()'d PurchaseRow holds (RUNWEB1-07).
 */
import { describe, expect, test } from 'bun:test';
import { productNamePartsOf } from '../../../../lib/productName';
import { rowName } from '../rowName';

const UNKNOWN = 'Unknown product';

describe('rowName', () => {
  test("a known product: its name, the stall's language on a second line", () => {
    const parts = productNamePartsOf('en', 'ru');
    const beef = { names: { en: 'Beef', ru: 'Говядина' } };
    const name = rowName(parts, beef, UNKNOWN);
    expect(name).toEqual({ primary: 'Beef', secondary: 'Говядина', secondaryLang: 'ru' });
    expect(rowName(parts, beef, UNKNOWN)).toBe(name);
  });

  test('a product the catalog has not loaded: "unknown product", the same object each time', () => {
    // RUNWEB1-38: not the start of its id.
    const parts = productNamePartsOf('en', 'ru');
    const name = rowName(parts, undefined, UNKNOWN);
    expect(name).toEqual({ primary: UNKNOWN, secondary: null });
    expect(rowName(parts, null, UNKNOWN)).toBe(name);
  });
});
