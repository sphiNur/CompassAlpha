/**
 * The dish editor's check before Save, and what it sends.
 *
 * Review CONF-10 (2026-11-11): the amount and price rules were the
 * server's, written out again here; they come from limits.ts now, where
 * the server reads them. A problem is the catalog key the editor shows,
 * not an Error made up for the error toast (as CONF-24 did for sales).
 */
import { PURCHASE_PRICE_RE, RECIPE_QTY_MESSAGE, recipeQtyProblem } from '@compass/contracts/limits';
import { cleanNames, type CatalogNames } from './catalogNames';

export interface DishIngredientDraft {
  /** The row's React key; never sent. */
  key: string;
  skuId: string;
  qtyPerServing: string;
  note: string;
}

export type DishDraftProblem =
  | 'dishes.errors.namesRequired'
  | 'dishes.errors.archivedIngredient'
  | 'dishes.errors.incompleteIngredient'
  | (typeof RECIPE_QTY_MESSAGE)[keyof typeof RECIPE_QTY_MESSAGE]
  | 'dishes.errors.priceTooLarge'
  | 'dishes.errors.duplicateIngredient';

export type DishDraftCheck =
  | { ok: false; problem: DishDraftProblem }
  | {
      ok: true;
      names: Record<string, string>;
      unitPrice: string | null;
      ingredients: Array<{ skuId: string; qtyPerServing: string; note: string | null }>;
    };

export function checkDishDraft(
  draft: {
    names: CatalogNames;
    unitPrice: string;
    ingredients: readonly DishIngredientDraft[];
  },
  isArchivedSku: (skuId: string) => boolean,
): DishDraftCheck {
  // Empty languages are left out (cleanNames), not sent as ''.
  const names = cleanNames(draft.names);
  if (Object.keys(names).length === 0) {
    return { ok: false, problem: 'dishes.errors.namesRequired' };
  }
  // CLS-11 (2026-10-30): a row with a product but no amount (or the
  // reverse) was dropped without a word, and amounts / prices were
  // rounded by toFixed. Only a row left completely blank is skipped now;
  // anything half-filled or with too many digits stops the save.
  const filled = draft.ingredients.filter((i) => i.skuId || i.qtyPerServing.trim());
  // DX-DSH-1: an archived product must be replaced or its row removed;
  // the row itself says so. The server refuses it as well.
  if (filled.some((i) => isArchivedSku(i.skuId))) {
    return { ok: false, problem: 'dishes.errors.archivedIngredient' };
  }
  if (filled.some((i) => !i.skuId || !(Number(i.qtyPerServing) > 0))) {
    return { ok: false, problem: 'dishes.errors.incompleteIngredient' };
  }
  for (const i of filled) {
    const problem = recipeQtyProblem(i.qtyPerServing.trim());
    if (problem) return { ok: false, problem: RECIPE_QTY_MESSAGE[problem] };
  }
  const price = draft.unitPrice.trim();
  if (price && !PURCHASE_PRICE_RE.test(price)) {
    return { ok: false, problem: 'dishes.errors.priceTooLarge' };
  }
  const ingredients = filled.map((i) => ({
    skuId: i.skuId,
    qtyPerServing: i.qtyPerServing.trim(),
    note: i.note.trim() || null,
  }));
  // 2026-10-21 CA-55: the server refuses a product listed twice; say so
  // before the round trip.
  if (new Set(ingredients.map((i) => i.skuId)).size !== ingredients.length) {
    return { ok: false, problem: 'dishes.errors.duplicateIngredient' };
  }
  return { ok: true, names, unitPrice: price || null, ingredients };
}
