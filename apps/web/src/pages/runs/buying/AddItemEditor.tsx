import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ChoiceGroup, Field, List, Money, Row, Sheet, StatusChip } from '@compass/ui/kit';
import type { PaymentMethod } from '@compass/ui/kit';
import { useAuthStore } from '../../../stores/authStore';
import type { useI18n } from '../../../hooks/useI18n';
import { useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney, formatQty } from '../../../lib/format';
import { matchesNameLike, normalizeQuery } from '../../../lib/searchMatch';
import { fromDisplayPrice, toDisplayPrice } from '../lib/priceMath';
import { evenSplitQty } from '../lib/splitQty';
import type { AddItemDraft } from './drafts';

export interface AddItemEditorProps {
  draft: AddItemDraft | null;
  /** Stores this run already buys for; nothing can be added for another. */
  runStoreIds: string[];
  /**
   * For each product already on the run: which stores asked for it, and
   * its state. A store that already has the product gets the addition as
   * a separate cost, so the recorded purchase is not rewritten.
   */
  existingStoreIdsBySku: Map<string, { storeIds: Set<string>; status: string }>;
  skus: Array<{
    id: string;
    names: Record<string, string>;
    code?: string | null;
    unit: string;
    step: string;
    isArchived: boolean;
  }>;
  expenseTemplates: Array<{
    id: string;
    label: string;
    unitHint: string | null;
    defaultQty: string;
    defaultUnitPrice: string;
    defaultPaymentMethod: string;
  }>;
  storeById: Map<string, { id: string; name: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  priceInThousands: boolean;
  onCancel: () => void;
  onChange: (draft: AddItemDraft | null) => void;
  onSubmit: (draft: AddItemDraft) => void;
  submitting: boolean;
}

/**
 * Adding what was not planned: a product a store turns out to need, or
 * spending that is not a product (a porter, bags). The form unfolds as it
 * is filled in: what, then for whom, then how much, so the first screen
 * is one question and not ten fields.
 */
export function AddItemEditor({
  draft,
  runStoreIds,
  existingStoreIdsBySku,
  skus,
  expenseTemplates,
  storeById,
  productName,
  i18n,
  priceInThousands,
  onCancel,
  onChange,
  onSubmit,
  submitting,
}: AddItemEditorProps) {
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const unitLabel = useUnitLabel();
  const [search, setSearch] = useState('');
  const [price, setPrice] = useState('');
  // The entry whose stores the person has chosen for themselves.
  const storesChosenFor = useRef<string | null>(null);

  useEffect(() => {
    if (!draft) {
      setSearch('');
      setPrice('');
      return;
    }
    setPrice(toDisplayPrice(draft.unitPrice, priceInThousands));
    // Only when another entry opens or the unit flips, not per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.runId, draft?.skuId, draft?.mode, priceInThousands]);

  const matches = useMemo(() => {
    const tokens = normalizeQuery(search);
    return (
      skus
        .filter((sku) => !sku.isArchived)
        // "Not available" is said about the whole run; adding the product
        // again for one store would quietly contradict it.
        .filter((sku) => existingStoreIdsBySku.get(sku.id)?.status !== 'unavailable')
        .filter(
          (sku) =>
            !tokens ||
            matchesNameLike(
              { names: sku.names as Record<string, string> | null, code: sku.code ?? null },
              tokens,
            ),
        )
        .slice(0, 20)
    );
  }, [skus, existingStoreIdsBySku, search]);

  const stores = useMemo(
    () =>
      runStoreIds
        .map((id) => storeById.get(id))
        .filter((s): s is { id: string; name: string } => !!s),
    [runStoreIds, storeById],
  );

  const split = (storeIds: string[], qty: string): Map<string, string> => {
    const next = new Map<string, string>();
    // Every chosen store is entered even before a quantity exists, or the
    // quantity field (which waits for a store) would never appear.
    for (const [id, share] of evenSplitQty(storeIds, qty)) next.set(id, share);
    return next;
  };

  // New spending starts shared between every store of the run, until the
  // person chooses stores themselves; deselecting one then sticks.
  //
  // Not "done once per entry": every field here writes the whole draft it
  // was rendered with, so a letter typed in the instant this default lands
  // writes back a draft from before it, with no stores. Marking the entry
  // as done at that point left it without stores for good, and with no
  // stores the quantity and price fields never appear. So it is applied
  // again whenever the stores are empty and nobody emptied them.
  useEffect(() => {
    if (
      !draft ||
      draft.mode !== 'expense' ||
      draft.expenseScope !== 'shared' ||
      draft.splits.size > 0 ||
      stores.length === 0 ||
      storesChosenFor.current === draft.expenseId
    ) {
      return;
    }
    onChange({
      ...draft,
      splits: split(
        stores.map((s) => s.id),
        draft.actualQty,
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, onChange, stores]);

  if (!draft) return null;

  const isSku = draft.mode === 'sku';
  const sku = isSku && draft.skuId ? skus.find((s) => s.id === draft.skuId) : undefined;
  const onRun = sku ? (existingStoreIdsBySku.get(sku.id) ?? null) : null;
  const storeId = draft.splits.size === 1 ? [...draft.splits.keys()][0]! : '';
  const storeHasIt = !!storeId && !!onRun?.storeIds.has(storeId);
  const asSeparateCost =
    isSku && !!onRun && (draft.skuCostMode === 'separateExpense' || storeHasIt);

  const allocated = [...draft.splits.values()].reduce((sum, v) => sum + (Number(v) || 0), 0);
  const allocationOk = Math.abs(allocated - Number(draft.actualQty || 0)) < 0.001;
  const named = isSku ? !!draft.skuId : draft.label.trim().length > 0;
  const canSubmit =
    named &&
    Number(draft.actualQty) > 0 &&
    Number(draft.unitPrice) > 0 &&
    draft.splits.size > 0 &&
    allocationOk &&
    draft.reason.trim().length > 0 &&
    !submitting;
  const total = Number(draft.actualQty || 0) * Number(draft.unitPrice || 0);
  const unit = isSku ? unitLabel(sku?.unit) : draft.unitHint.trim();
  const chosen = <StatusChip tone="done">{i18n.t('buy.chosen')}</StatusChip>;
  const readyForAmounts = isSku ? !!sku && !!storeId : named && draft.splits.size > 0;

  const setQty = (qty: string) => {
    const ids = [...draft.splits.keys()];
    const splits =
      !isSku && ids.length > 1 ? split(ids, qty) : new Map(ids[0] ? [[ids[0], qty]] : []);
    onChange({ ...draft, actualQty: qty, splits });
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onCancel()}
      title={
        (isSku
          ? i18n.t('run.action.addItem.title')
          : i18n.t('run.action.addExpense.title')) as string
      }
      keepFocus
      actions={
        <Button
          variant="primary"
          data-testid="save-added"
          busy={submitting}
          disabled={!canSubmit}
          onClick={() => onSubmit(draft)}
        >
          {isSku ? i18n.t('run.action.addItem.save') : i18n.t('run.action.addExpense.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-lg">
        <ChoiceGroup<AddItemDraft['mode']>
          compact
          label={i18n.t('buy.addWhat') as string}
          value={draft.mode}
          onChange={(mode) => {
            if (mode === draft.mode) return;
            // Who it is for is asked differently in the two forms, so
            // that part starts over; quantity, price and reason stay.
            onChange({
              ...draft,
              mode,
              skuId: mode === 'sku' ? null : draft.skuId,
              skuCostMode: 'merge',
              label: mode === 'expense' ? '' : draft.label,
              splits: new Map(),
              splitPrices: new Map(),
              splitPaymentMethods: new Map(),
              perStorePricing: false,
            });
          }}
          options={[
            { value: 'sku', label: i18n.t('run.action.addItem.modeSku') as string },
            { value: 'expense', label: i18n.t('run.action.addItem.modeExpense') as string },
          ]}
        />

        {isSku && !sku ? (
          <>
            <Field
              type="search"
              label={i18n.t('run.action.addItem.searchPlaceholder') as string}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {matches.length === 0 ? (
              <p className="text-body text-secondary">{i18n.t('run.action.addItem.noMatch')}</p>
            ) : (
              <List>
                {matches.map((m) => (
                  <Row
                    key={m.id}
                    picks
                    data-testid="add-sku-option"
                    title={productName(m)}
                    detail={unitLabel(m.unit)}
                    onPress={() =>
                      onChange({
                        ...draft,
                        skuId: m.id,
                        skuCostMode: existingStoreIdsBySku.has(m.id) ? 'separateExpense' : 'merge',
                      })
                    }
                  />
                ))}
              </List>
            )}
          </>
        ) : null}

        {isSku && sku ? (
          <>
            <List>
              <Row
                title={productName(sku)}
                detail={i18n.t('run.action.addItem.changeSku')}
                onPress={() => onChange({ ...draft, skuId: null, skuCostMode: 'merge' })}
              />
            </List>
            {onRun ? (
              <>
                <p className="text-body text-secondary">
                  {i18n.t('run.action.addItem.crossStoreHint', {
                    stores: [...onRun.storeIds]
                      .map((id) => storeById.get(id)?.name ?? id.slice(0, 8))
                      .join(', '),
                  })}
                </p>
                <ChoiceGroup<AddItemDraft['skuCostMode']>
                  label={i18n.t('run.action.addItem.costModeTitle') as string}
                  value={asSeparateCost ? 'separateExpense' : 'merge'}
                  onChange={(skuCostMode) => {
                    // A store that already has the product can only take
                    // it as a separate cost.
                    if (skuCostMode === 'merge' && storeHasIt) return;
                    onChange({ ...draft, skuCostMode });
                  }}
                  options={[
                    { value: 'merge', label: i18n.t('run.action.addItem.costModeMerge') as string },
                    {
                      value: 'separateExpense',
                      label: i18n.t('run.action.addItem.costModeSeparate') as string,
                    },
                  ]}
                />
                <p className="text-body text-secondary">
                  {storeHasIt
                    ? i18n.t('run.action.addItem.storeAlreadyHasSkuHint')
                    : asSeparateCost
                      ? i18n.t('run.action.addItem.separatePriceHint')
                      : i18n.t('run.action.addItem.mergePriceHint')}
                </p>
              </>
            ) : null}
            <section className="flex flex-col gap-sm">
              <h3 className="text-label text-ink">{i18n.t('run.action.addItem.targetStore')}</h3>
              <List>
                {stores.map((st) => (
                  <Row
                    key={st.id}
                    picks
                    data-testid="add-store-option"
                    title={st.name}
                    detail={
                      onRun?.storeIds.has(st.id)
                        ? i18n.t('run.action.addItem.storeAlreadyHasSkuShort')
                        : undefined
                    }
                    value={st.id === storeId ? chosen : undefined}
                    onPress={() =>
                      onChange({
                        ...draft,
                        splits: new Map([[st.id, draft.actualQty]]),
                        skuCostMode: onRun?.storeIds.has(st.id)
                          ? 'separateExpense'
                          : draft.skuCostMode,
                      })
                    }
                  />
                ))}
              </List>
            </section>
          </>
        ) : null}

        {!isSku ? (
          <>
            <Field
              label={i18n.t('run.action.addExpense.labelInput') as string}
              value={draft.label}
              onChange={(e) => onChange({ ...draft, label: e.target.value })}
              placeholder={i18n.t('run.action.addExpense.labelPlaceholder') as string}
            />
            {expenseTemplates.length > 0 && !named ? (
              <section className="flex flex-col gap-sm">
                <h3 className="text-label text-ink">{i18n.t('run.action.addExpense.templates')}</h3>
                <List>
                  {expenseTemplates.map((tpl) => (
                    <Row
                      key={tpl.id}
                      picks
                      data-testid="spending-template"
                      title={tpl.label}
                      value={<Money amount={formatMoney(tpl.defaultUnitPrice)} />}
                      onPress={() => {
                        setPrice(toDisplayPrice(tpl.defaultUnitPrice, priceInThousands));
                        onChange({
                          ...draft,
                          label: tpl.label,
                          unitHint: tpl.unitHint ?? '',
                          actualQty: tpl.defaultQty,
                          unitPrice: tpl.defaultUnitPrice,
                          paymentMethod:
                            tpl.defaultPaymentMethod === 'transfer' ? 'transfer' : 'cash',
                          splits:
                            draft.splits.size > 0
                              ? split([...draft.splits.keys()], tpl.defaultQty)
                              : draft.splits,
                        });
                      }}
                    />
                  ))}
                </List>
              </section>
            ) : null}
            {named ? (
              <>
                <Field
                  label={i18n.t('run.action.addExpense.unitHint') as string}
                  value={draft.unitHint}
                  onChange={(e) => onChange({ ...draft, unitHint: e.target.value })}
                  placeholder={i18n.t('run.action.addExpense.unitHintPlaceholder') as string}
                />
                <ChoiceGroup<AddItemDraft['expenseScope']>
                  label={i18n.t('run.action.addExpense.scopeTitle') as string}
                  value={draft.expenseScope}
                  onChange={(expenseScope) => {
                    storesChosenFor.current = draft.expenseId;
                    onChange({
                      ...draft,
                      expenseScope,
                      splits:
                        expenseScope === 'shared'
                          ? split(
                              stores.map((s) => s.id),
                              draft.actualQty,
                            )
                          : new Map(),
                    });
                  }}
                  options={[
                    {
                      value: 'shared',
                      label: i18n.t('run.action.addExpense.scopeShared') as string,
                    },
                    { value: 'store', label: i18n.t('run.action.addExpense.scopeStore') as string },
                  ]}
                />
                <List>
                  {stores.map((st) => {
                    const included = draft.splits.has(st.id);
                    return (
                      <Row
                        key={st.id}
                        picks
                        data-testid="spending-store"
                        title={st.name}
                        value={
                          !included ? undefined : draft.splits.size > 1 ? (
                            <span className="text-money text-ink">
                              {formatQty(draft.splits.get(st.id) ?? '0')}
                            </span>
                          ) : (
                            chosen
                          )
                        }
                        onPress={() => {
                          storesChosenFor.current = draft.expenseId;
                          const ids =
                            draft.expenseScope === 'store'
                              ? [st.id]
                              : included
                                ? [...draft.splits.keys()].filter((id) => id !== st.id)
                                : [...draft.splits.keys(), st.id];
                          onChange({ ...draft, splits: split(ids, draft.actualQty) });
                        }}
                      />
                    );
                  })}
                </List>
              </>
            ) : null}
          </>
        ) : null}

        {readyForAmounts ? (
          <>
            <Field
              numeric
              label={i18n.t('buy.qty') as string}
              value={draft.actualQty}
              onChange={(e) => setQty(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              suffix={unit || undefined}
            />
            <Field
              numeric
              label={i18n.t('buy.unitPrice', { unit: unit || '1' }) as string}
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                onChange({
                  ...draft,
                  unitPrice: fromDisplayPrice(e.target.value, priceInThousands),
                });
              }}
              onFocus={(e) => e.currentTarget.select()}
              suffix={priceInThousands ? `×1000 ${currency}` : currency}
            />
            <div className="flex items-baseline justify-between gap-lg">
              <span className="text-body text-secondary">{i18n.t('buy.total')}</span>
              <Money
                amount={total > 0 ? formatMoney(Math.round(total)) : '—'}
                currency={currency}
                size="lg"
              />
            </div>
            <ChoiceGroup<PaymentMethod>
              label={i18n.t('run.label.paymentMethod') as string}
              value={draft.paymentMethod}
              onChange={(paymentMethod) => onChange({ ...draft, paymentMethod })}
              options={[
                { value: 'cash', label: i18n.t('run.label.paymentCash') as string },
                { value: 'transfer', label: i18n.t('run.label.paymentTransfer') as string },
              ]}
            />
            {/* Asked for because this is spending nobody ordered. */}
            <Field
              label={i18n.t('run.action.addItem.reasonLabel') as string}
              value={draft.reason}
              onChange={(e) => onChange({ ...draft, reason: e.target.value })}
              placeholder={i18n.t('run.action.addItem.reasonPlaceholder') as string}
            />
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
