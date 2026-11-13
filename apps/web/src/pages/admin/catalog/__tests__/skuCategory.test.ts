import { afterEach, describe, expect, it } from 'bun:test';
import { lastSkuCategory, pickNewSkuCategory, rememberSkuCategory } from '../skuCategory';

const cats = [
  { id: 'veg', isArchived: false },
  { id: 'meat', isArchived: false },
  { id: 'old', isArchived: true },
];

describe('UX-18: the category a new product starts in', () => {
  afterEach(() => rememberSkuCategory(null));

  it('nothing remembered yet: no category', () => {
    expect(pickNewSkuCategory([lastSkuCategory()], cats)).toBeNull();
  });

  it('the category the last product was created in', () => {
    rememberSkuCategory('meat');
    expect(pickNewSkuCategory([lastSkuCategory()], cats)).toBe('meat');
  });

  it('a product created without a category resets it', () => {
    rememberSkuCategory('meat');
    rememberSkuCategory(null);
    expect(pickNewSkuCategory([lastSkuCategory()], cats)).toBeNull();
  });

  it('an earlier candidate (e.g. a list filter) wins over the remembered one', () => {
    expect(pickNewSkuCategory(['veg', 'meat'], cats)).toBe('veg');
    expect(pickNewSkuCategory([null, 'meat'], cats)).toBe('meat');
  });

  it('skips an archived, deleted or other-organisation category', () => {
    expect(pickNewSkuCategory(['old'], cats)).toBeNull();
    expect(pickNewSkuCategory(['gone', 'veg'], cats)).toBe('veg');
    expect(pickNewSkuCategory(['meat'], undefined)).toBeNull();
  });
});
