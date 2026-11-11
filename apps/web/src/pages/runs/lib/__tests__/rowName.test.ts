/**
 * Review RUNWEB1-09: the run rows' name, two lines (UI-4), the same
 * object each time so the memo()'d PurchaseRow holds (RUNWEB1-07).
 */
import { describe, expect, test } from 'bun:test';
import { productNamePartsOf } from '../../../../lib/productName';
import { rowName } from '../rowName';

const BEEF_ID = '7f3c2a10-5b4e-4d7a-9c1e-2f8b6a0d4e93';

describe('rowName', () => {
  test("a known product: its name, the stall's language on a second line", () => {
    const parts = productNamePartsOf('en', 'ru');
    const beef = { names: { en: 'Beef', ru: 'Говядина' } };
    const name = rowName(parts, beef, BEEF_ID);
    expect(name).toEqual({ primary: 'Beef', secondary: 'Говядина', secondaryLang: 'ru' });
    expect(rowName(parts, beef, BEEF_ID)).toBe(name);
  });

  test('a product the catalog has not loaded: the start of its id, the same object each time', () => {
    const parts = productNamePartsOf('en', 'ru');
    const name = rowName(parts, undefined, BEEF_ID);
    expect(name).toEqual({ primary: '7f3c2a10', secondary: null });
    expect(rowName(parts, null, BEEF_ID)).toBe(name);
  });
});
