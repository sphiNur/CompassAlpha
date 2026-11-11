/**
 * Review CONF-10: the dish editor's check reads the server's rules
 * (limits.ts) and names each problem by its catalog key.
 */
import { describe, expect, test } from 'bun:test';
import { checkDishDraft, type DishIngredientDraft } from '../dishDraft';

const names = { uz: '', ru: '', en: ' Plov ', zh: '' };
const row = (skuId: string, qtyPerServing: string, note = ''): DishIngredientDraft => ({
  key: `k-${skuId}-${qtyPerServing}`,
  skuId,
  qtyPerServing,
  note,
});
const notArchived = (_skuId: string) => false;

function problemOf(
  draft: Parameters<typeof checkDishDraft>[0],
  archived: (skuId: string) => boolean = notArchived,
) {
  const check = checkDishDraft(draft, archived);
  return check.ok ? null : check.problem;
}

describe('checkDishDraft (CONF-10)', () => {
  test('a dish without any name is refused', () => {
    expect(
      problemOf({ names: { uz: ' ', ru: '', en: '', zh: '' }, unitPrice: '', ingredients: [] }),
    ).toBe('dishes.errors.namesRequired');
  });

  test('a row with an archived product is refused', () => {
    expect(
      problemOf(
        { names, unitPrice: '', ingredients: [row('sku-old', '1')] },
        (skuId) => skuId === 'sku-old',
      ),
    ).toBe('dishes.errors.archivedIngredient');
  });

  test('a half-filled row is refused; a blank one is skipped', () => {
    expect(problemOf({ names, unitPrice: '', ingredients: [row('', '1')] })).toBe(
      'dishes.errors.incompleteIngredient',
    );
    expect(problemOf({ names, unitPrice: '', ingredients: [row('sku-1', '')] })).toBe(
      'dishes.errors.incompleteIngredient',
    );
    expect(problemOf({ names, unitPrice: '', ingredients: [row('', '  ')] })).toBeNull();
  });

  test('the amount follows the server: at most 8 digits and 4 decimals', () => {
    expect(problemOf({ names, unitPrice: '', ingredients: [row('sku-1', '0.00001')] })).toBe(
      'dishes.errors.qtyTooLarge',
    );
    expect(problemOf({ names, unitPrice: '', ingredients: [row('sku-1', '123456789')] })).toBe(
      'dishes.errors.qtyTooLarge',
    );
    expect(problemOf({ names, unitPrice: '', ingredients: [row('sku-1', '0.0001')] })).toBeNull();
  });

  test('the price follows the server: at most 12 digits and 2 decimals', () => {
    expect(problemOf({ names, unitPrice: '1.005', ingredients: [] })).toBe(
      'dishes.errors.priceTooLarge',
    );
    expect(problemOf({ names, unitPrice: '1234567890123', ingredients: [] })).toBe(
      'dishes.errors.priceTooLarge',
    );
    expect(problemOf({ names, unitPrice: '35000.50', ingredients: [] })).toBeNull();
  });

  test('a product listed twice is refused', () => {
    expect(
      problemOf({ names, unitPrice: '', ingredients: [row('sku-1', '1'), row('sku-1', '2')] }),
    ).toBe('dishes.errors.duplicateIngredient');
  });

  test('a good draft is sent trimmed, without blank rows or empty languages', () => {
    expect(
      checkDishDraft(
        {
          names,
          unitPrice: ' 35000 ',
          ingredients: [row('sku-1', ' 0.25 ', ' fresh '), row('', ''), row('sku-2', '1')],
        },
        notArchived,
      ),
    ).toEqual({
      ok: true,
      names: { en: 'Plov' },
      unitPrice: '35000',
      ingredients: [
        { skuId: 'sku-1', qtyPerServing: '0.25', note: 'fresh' },
        { skuId: 'sku-2', qtyPerServing: '1', note: null },
      ],
    });
    expect(checkDishDraft({ names, unitPrice: '', ingredients: [] }, notArchived)).toEqual({
      ok: true,
      names: { en: 'Plov' },
      unitPrice: null,
      ingredients: [],
    });
  });
});
