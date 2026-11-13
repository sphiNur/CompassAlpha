/**
 * The "+ add" sheet's product, in its product mode: the one picked, or a
 * search of the catalog to pick one from.
 */
import { useMemo } from 'react';
import { Button, Input, NameCell } from '@compass/ui';
import { useI18n, useProductNameParts, useUnitLabel } from '../../../hooks/useI18n';
import { normalizeQuery, rankNameLike } from '../../../lib/searchMatch';
import type { AddItemSku, ExistingSkuStores } from './drafts';

export function SkuPicker({
  skus,
  existingStoreIdsBySku,
  selectedSku,
  search,
  onSearch,
  onPick,
  onClear,
}: {
  skus: AddItemSku[];
  existingStoreIdsBySku: ExistingSkuStores;
  selectedSku: AddItemSku | null | undefined;
  /** Kept by the sheet, so a product changed back finds the search as it was. */
  search: string;
  onSearch: (text: string) => void;
  onPick: (sku: AddItemSku) => void;
  onClear: () => void;
}) {
  const i18n = useI18n();
  // 2026-07-30 (flow review): the SKU picker rows showed the raw canonical
  // unit while every other run surface showed the localized label.
  const unitLabel = useUnitLabel();
  // UI-4 (review RUNWEB2-06): the picked product and the search results
  // show the name on two lines, never "primary (secondary)" cut short.
  const productNameParts = useProductNameParts();

  // Filter the SKU list: archived and unavailable-in-run SKUs stay out,
  // but purchasable existing SKUs remain selectable. Duplicate store/SKU
  // entries are recorded as store-scoped expenses so prices can differ.
  const filteredSkus = useMemo(() => {
    const tokens = normalizeQuery(search);
    const pickable = skus.filter((sku) => {
      if (sku.isArchived) return false;
      const existing = existingStoreIdsBySku.get(sku.id);
      if (existing) {
        // N/A is a run-wide signal; the purchaser can't override it by
        // re-adding the same SKU as a different store expense.
        if (existing.status === 'unavailable') return false;
      }
      return true;
    });
    // Ranked before the cut to 20: in catalog order the product the user
    // meant could fall past the 20th match and never show.
    return rankNameLike(
      pickable,
      tokens,
      (sku) => ({ names: sku.names, code: sku.code ?? null }),
      i18n.locale,
    ).slice(0, 20);
  }, [skus, existingStoreIdsBySku, search, i18n.locale]);

  if (selectedSku) {
    const selectedName = productNameParts(selectedSku);
    return (
      <div className="flex items-center justify-between rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2">
        <div className="min-w-0">
          <NameCell
            primary={selectedName.primary}
            secondary={selectedName.secondary}
            primaryLang={selectedName.primaryLang}
            secondaryLang={selectedName.secondaryLang}
          />
          <div className="text-old-label text-[var(--c-fg-muted)]">
            {unitLabel.uncounted(selectedSku.unit)}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={onClear}
          // DX-VIS-6: hit-44 (it was 22px tall to a finger).
          className="shrink-0"
        >
          {i18n.t('run.action.addItem.changeSku')}
        </Button>
      </div>
    );
  }

  return (
    <>
      <Input
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={i18n.t('run.action.addItem.searchPlaceholder')}
        autoFocus
      />
      <ul className="flex max-h-72 flex-col overflow-y-auto rounded-[var(--r-utility)] border border-[var(--c-divider)]">
        {filteredSkus.length === 0 ? (
          <li className="px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('run.action.addItem.noMatch')}
          </li>
        ) : (
          filteredSkus.map((sku) => {
            const nm = productNameParts(sku);
            return (
              <li key={sku.id} className="border-b border-[var(--c-divider)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => onPick(sku)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left active:bg-[var(--c-surface-2)]"
                >
                  <NameCell
                    as="span"
                    primary={nm.primary}
                    secondary={nm.secondary}
                    primaryLang={nm.primaryLang}
                    secondaryLang={nm.secondaryLang}
                  />
                  <span className="shrink-0 text-old-label text-[var(--c-fg-muted)]">
                    {unitLabel.uncounted(sku.unit)}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </>
  );
}
