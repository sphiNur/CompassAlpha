/**
 * Which store a product added from the "+ add" sheet goes to (single-store
 * v1), and, for a product already in the run, whether it joins that line
 * or is recorded as a cost of its own (M3.54).
 */
import { Field, FieldLabel, Segmented, Select } from '@compass/ui';
import { useI18n } from '../../../hooks/useI18n';
import { formatList } from '../../../lib/listFormat';
import type { StoreLite } from '../types';
import type { AddItemDraft } from './drafts';

export function SkuStoreFields({
  draft,
  onChange,
  existing,
  storeChoices,
  storeById,
  selectedStoreId,
  selectedStoreAlreadyHasSku,
  recordsAsExpense,
}: {
  draft: AddItemDraft;
  onChange: (d: AddItemDraft) => void;
  /** The stores the picked product is already in the run for, and its status. */
  existing: { storeIds: Set<string>; status: string } | null;
  storeChoices: StoreLite[];
  storeById: Map<string, StoreLite>;
  selectedStoreId: string;
  selectedStoreAlreadyHasSku: boolean;
  recordsAsExpense: boolean;
}) {
  const i18n = useI18n();
  return (
    <>
      {/* M3.54 (2026-05-23): cross-store augmentation hint. Renders when
          the picked SKU is already in this run for some other stores —
          explains that the new demand will be merged into the existing
          row (purchaseItem / revisePurchase under the hood) so the manager
          doesn't see "duplicate apple line". Lists the stores that already
          have demand so the user knows which stores aren't available in
          the dropdown. */}
      {existing ? (
        <div className="rounded-[var(--r-utility)] bg-[color:color-mix(in_oklch,var(--c-warning)_10%,transparent)] px-3 py-2 text-old-label text-[var(--c-fg)] ring-1 ring-[var(--c-warning)]">
          {i18n.t('run.action.addItem.crossStoreHint', {
            stores: formatList(
              [...existing.storeIds].map(
                (id) => storeById.get(id)?.name ?? i18n.t('common.unknownStore'),
              ),
              i18n.locale,
            ),
          })}
        </div>
      ) : null}
      {existing ? (
        <div className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] p-2">
          <FieldLabel className="mb-1">{i18n.t('run.action.addItem.costModeTitle')}</FieldLabel>
          {/* Review UI-07 (2026-11-11): the kit's Segmented, now that an
              option can be disabled (DX-VIS-6 / DX-VIS-7 kept two
              hand-written buttons for that). "Add to existing" is
              disabled when the chosen store already has the line, and
              the hint below says so. */}
          <Segmented<'merge' | 'separateExpense'>
            value={recordsAsExpense ? 'separateExpense' : 'merge'}
            onChange={(mode) => onChange({ ...draft, skuCostMode: mode })}
            options={[
              {
                value: 'merge',
                label: i18n.t('run.action.addItem.costModeMerge'),
                disabled: selectedStoreAlreadyHasSku,
              },
              {
                value: 'separateExpense',
                label: i18n.t('run.action.addItem.costModeSeparate'),
              },
            ]}
            ariaLabel={i18n.t('run.action.addItem.costModeTitle')}
          />
          <p className="mt-1 text-old-label leading-snug text-[var(--c-fg-muted)]">
            {selectedStoreAlreadyHasSku
              ? i18n.t('run.action.addItem.storeAlreadyHasSkuHint')
              : recordsAsExpense
                ? i18n.t('run.action.addItem.separatePriceHint')
                : existing.status === 'purchased'
                  ? // 2026-10-21 FE-04: merging into a bought row keeps its
                    // price, supplier and receipt; only the new store is added.
                    i18n.t('run.action.addItem.mergePurchasedHint')
                  : i18n.t('run.action.addItem.mergePriceHint')}
          </p>
        </div>
      ) : null}
      <Field label={i18n.t('run.action.addItem.targetStore')}>
        <Select
          value={selectedStoreId}
          onChange={(e) => {
            const next = new Map<string, string>();
            if (e.target.value && draft.actualQty) {
              next.set(e.target.value, draft.actualQty);
            } else if (e.target.value) {
              next.set(e.target.value, '');
            }
            onChange({
              ...draft,
              splits: next,
              skuCostMode: existing?.storeIds.has(e.target.value)
                ? 'separateExpense'
                : draft.skuCostMode,
            });
          }}
        >
          <option value="">{i18n.t('run.action.addItem.pickStore')}</option>
          {storeChoices.map((st) => (
            <option key={st.id} value={st.id}>
              {/* RUNWEB2-24: brackets from the catalog (「（已有）」). */}
              {existing?.storeIds.has(st.id)
                ? i18n.t('run.action.addItem.storeAlreadyHasSkuShort', { store: st.name })
                : st.name}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}
