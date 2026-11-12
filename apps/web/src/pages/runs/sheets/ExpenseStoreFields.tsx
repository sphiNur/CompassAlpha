/**
 * Which stores an expense from the "+ add" sheet is charged to: shared
 * evenly across the stores picked, or one store's own cost (M3.44).
 */
import { FieldLabel, Segmented, pillButtonClass } from '@compass/ui';
import { useI18n } from '../../../hooks/useI18n';
import { evenSplitQty } from '../lib/splitQty';
import type { StoreLite } from '../types';
import type { AddItemDraft } from './drafts';

export function ExpenseStoreFields({
  draft,
  onChange,
  storeChoices,
}: {
  draft: AddItemDraft;
  onChange: (d: AddItemDraft) => void;
  storeChoices: StoreLite[];
}) {
  const i18n = useI18n();
  return (
    <div>
      <div className="mb-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
        <FieldLabel className="mb-1">{i18n.t('run.action.addExpense.scopeTitle')}</FieldLabel>
        {/* DX-VIS-7 (2026-11-01): Segmented (selection announced). */}
        <Segmented
          value={draft.expenseScope}
          ariaLabel={i18n.t('run.action.addExpense.scopeTitle')}
          onChange={(scope) =>
            onChange({
              ...draft,
              expenseScope: scope,
              splits:
                scope === 'shared'
                  ? evenSplitQty(
                      storeChoices.map((store) => store.id),
                      draft.actualQty,
                    )
                  : new Map(),
            })
          }
          options={[
            { value: 'shared', label: i18n.t('run.action.addExpense.scopeShared') },
            { value: 'store', label: i18n.t('run.action.addExpense.scopeStore') },
          ]}
        />
        <p className="mt-1 text-old-label leading-snug text-[var(--c-fg-muted)]">
          {draft.expenseScope === 'shared'
            ? i18n.t('run.action.addExpense.scopeSharedHint')
            : i18n.t('run.action.addExpense.scopeStoreHint')}
        </p>
      </div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <FieldLabel>
          {draft.expenseScope === 'shared'
            ? i18n.t('run.action.addExpense.targetStores')
            : i18n.t('run.action.addItem.targetStore')}
        </FieldLabel>
        <span className="text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('run.action.addExpense.splitHint', {
            n: draft.splits.size,
          })}
        </span>
      </div>
      {/* DX-VIS-6 / DX-VIS-8 (2026-11-01): kit pills (44px taps) with
          12px between wrapped rows so one row's tap area does not cover
          the next; aria-pressed says which stores are in. */}
      <div className="flex flex-wrap gap-x-1.5 gap-y-3">
        {storeChoices.map((st) => {
          const selected = draft.splits.has(st.id);
          return (
            <button
              key={st.id}
              type="button"
              onClick={() => {
                const nextIds =
                  draft.expenseScope === 'store'
                    ? [st.id]
                    : selected
                      ? [...draft.splits.keys()].filter((id) => id !== st.id)
                      : [...draft.splits.keys(), st.id];
                onChange({
                  ...draft,
                  splits: evenSplitQty(nextIds, draft.actualQty),
                });
              }}
              aria-pressed={selected}
              className={pillButtonClass(selected)}
            >
              {st.name}
              {selected && draft.splits.size > 1 ? (
                <span className="ml-1 tabular-nums opacity-80">
                  {draft.splits.get(st.id) ?? '0'}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {draft.splits.size > 1 ? (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...draft,
              splits: evenSplitQty([...draft.splits.keys()], draft.actualQty),
            })
          }
          // DX-VIS-6: hit-44 on the text link.
          className="hit-44 mt-2 text-old-label text-[var(--c-action)] active:opacity-70"
        >
          {i18n.t('run.action.addExpense.resplitEvenly')}
        </button>
      ) : null}
    </div>
  );
}
