import { useEffect, useMemo, useState } from 'react';
import { Button, ChoiceGroup, Field, List, Money, Row, Sheet, StatusChip } from '@compass/ui/kit';
import type { PaymentMethod } from '@compass/ui/kit';
import { useAuthStore } from '../../../stores/authStore';
import type { useI18n } from '../../../hooks/useI18n';
import { useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney, formatQty } from '../../../lib/format';
import { fromDisplayPrice, toDisplayPrice } from '../lib/priceMath';
import type { PurchaseDraft } from './drafts';

export interface PurchaseEditorProps {
  draft: PurchaseDraft | null;
  skuById: Map<string, { names: Record<string, string>; unit: string; step: string }>;
  storeById: Map<string, { id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  /** Prices are typed in thousands ("12" for 12,000) when this is on. */
  priceInThousands: boolean;
  onCancel: () => void;
  onChange: (draft: PurchaseDraft | null) => void;
  onSubmit: (draft: PurchaseDraft) => void;
  submitting: boolean;
  /** Take the purchase back entirely. Only for one already recorded. */
  onUndo?: () => void;
}

/**
 * The full form for one line: for when the quick sheet is not enough.
 * How much went to each store, a different price or payment per store,
 * which stall it came from. Also where a recorded purchase is corrected,
 * which needs a reason.
 */
export function PurchaseEditor({
  draft,
  skuById,
  storeById,
  suppliers,
  productName,
  i18n,
  priceInThousands,
  onCancel,
  onChange,
  onSubmit,
  submitting,
  onUndo,
}: PurchaseEditorProps) {
  const unitLabel = useUnitLabel();
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const sku = draft ? skuById.get(draft.skuId) : undefined;
  const unit = unitLabel(sku?.unit);
  const stores = useMemo(() => [...storeById.values()], [storeById]);
  const [pickingStall, setPickingStall] = useState(false);

  // What is typed, kept as typed: going through a number and back would
  // eat the "." of "12." while the next digit is on its way.
  const [price, setPrice] = useState('');
  useEffect(() => {
    setPrice(draft ? toDisplayPrice(draft.unitPrice, priceInThousands) : '');
    setPickingStall(false);
    // Only when a different line opens or the unit flips, not per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.skuId, draft?.isEdit, priceInThousands]);

  // With one store there is nothing to divide: it gets whatever was bought.
  useEffect(() => {
    if (!draft || draft.splits.size !== 1) return;
    const [storeId, qty] = [...draft.splits.entries()][0]!;
    if (qty !== draft.actualQty) {
      onChange({ ...draft, splits: new Map([[storeId, draft.actualQty]]) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.actualQty]);

  if (!draft) return null;

  const allocated = [...draft.splits.values()].reduce((sum, v) => sum + (Number(v) || 0), 0);
  const allocationOk = Math.abs(allocated - Number(draft.actualQty || 0)) < 0.001;
  const reasonOk = !draft.isEdit || draft.reason.trim().length > 0;
  const storePricesOk =
    !draft.perStorePricing ||
    [...draft.splits.entries()]
      .filter(([, qty]) => Number(qty) > 0)
      .every(([storeId]) => Number(draft.splitPrices.get(storeId) || draft.unitPrice) > 0);
  const canSubmit =
    Number(draft.actualQty) > 0 &&
    Number(draft.unitPrice) > 0 &&
    allocationOk &&
    reasonOk &&
    storePricesOk;

  const total = draft.perStorePricing
    ? [...draft.splits.entries()].reduce(
        (sum, [storeId, qty]) =>
          sum + (Number(qty) || 0) * Number(draft.splitPrices.get(storeId) || draft.unitPrice || 0),
        0,
      )
    : Number(draft.actualQty || 0) * Number(draft.unitPrice || 0);
  const priceSuffix = priceInThousands ? `×1000 ${currency}` : currency;
  const paymentOptions = [
    { value: 'cash' as const, label: i18n.t('run.label.paymentCash') as string },
    { value: 'transfer' as const, label: i18n.t('run.label.paymentTransfer') as string },
  ];
  const stall = suppliers.find((s) => s.id === draft.supplierId);
  const chosen = <StatusChip tone="done">{i18n.t('buy.chosen')}</StatusChip>;

  const setStoreQty = (storeId: string, value: string) => {
    const splits = new Map(draft.splits);
    if (value === '') splits.delete(storeId);
    else splits.set(storeId, value);
    onChange({ ...draft, splits });
  };

  const togglePerStore = () => {
    if (draft.perStorePricing) {
      onChange({ ...draft, perStorePricing: false });
      return;
    }
    // Each store starts from the price and method already entered.
    const splitPrices = new Map(draft.splitPrices);
    const splitPaymentMethods = new Map(draft.splitPaymentMethods);
    for (const storeId of draft.splits.keys()) {
      if (!splitPrices.has(storeId)) splitPrices.set(storeId, draft.unitPrice);
      if (!splitPaymentMethods.has(storeId)) splitPaymentMethods.set(storeId, draft.paymentMethod);
    }
    onChange({ ...draft, splitPrices, splitPaymentMethods, perStorePricing: true });
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onCancel()}
      title={sku ? productName(sku) : ''}
      keepFocus
      actions={
        <>
          <Button
            variant="primary"
            data-testid="save-full-purchase"
            busy={submitting}
            disabled={!canSubmit}
            onClick={() => onSubmit(draft)}
          >
            {/* When it cannot be saved, the button says what is missing. */}
            {!allocationOk
              ? i18n.t('run.label.splitsMismatch', {
                  sum: formatQty(String(allocated)),
                  target: formatQty(draft.actualQty || '0'),
                })
              : !reasonOk
                ? i18n.t('run.errors.reviseReasonRequired')
                : draft.isEdit
                  ? i18n.t('run.action.editPurchase')
                  : i18n.t('run.action.savePurchase')}
          </Button>
          {draft.isEdit && onUndo ? (
            <Button variant="ghost" data-testid="undo-purchase" onClick={onUndo}>
              <span className="text-danger">{i18n.t('run.action.undoPurchase')}</span>
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-lg">
        <Field
          numeric
          label={i18n.t('buy.qty') as string}
          value={draft.actualQty}
          onChange={(e) => onChange({ ...draft, actualQty: e.target.value })}
          onFocus={(e) => e.currentTarget.select()}
          suffix={unit}
        />
        {draft.perStorePricing ? null : (
          <Field
            numeric
            label={i18n.t('buy.unitPrice', { unit }) as string}
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              onChange({ ...draft, unitPrice: fromDisplayPrice(e.target.value, priceInThousands) });
            }}
            onFocus={(e) => e.currentTarget.select()}
            suffix={priceSuffix}
          />
        )}
        <div className="flex items-baseline justify-between gap-lg">
          <span className="text-body text-secondary">{i18n.t('buy.total')}</span>
          <Money amount={total > 0 ? formatMoney(total) : '—'} currency={currency} size="lg" />
        </div>
        {draft.perStorePricing ? null : (
          <ChoiceGroup<PaymentMethod>
            label={i18n.t('run.label.paymentMethod') as string}
            value={draft.paymentMethod}
            onChange={(paymentMethod) => onChange({ ...draft, paymentMethod })}
            options={paymentOptions}
          />
        )}

        <section className="flex flex-col gap-sm">
          <div className="flex items-baseline justify-between gap-lg">
            <h3 className="text-label text-ink">{i18n.t('run.action.allocateAcrossStores')}</h3>
            <span
              className={allocationOk ? 'text-body text-secondary' : 'text-body text-warning-ink'}
            >
              {formatQty(String(allocated))} / {formatQty(draft.actualQty || '0')} {unit}
            </span>
          </div>
          {stores.map((store) => {
            const qty = draft.splits.get(store.id) ?? '';
            return (
              <div key={store.id} className="flex flex-col gap-sm" data-testid="store-share">
                <Field
                  numeric
                  label={store.name}
                  value={qty}
                  onChange={(e) => setStoreQty(store.id, e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  suffix={unit}
                />
                {draft.perStorePricing && Number(qty) > 0 ? (
                  <>
                    <Field
                      numeric
                      label={`${store.name} · ${i18n.t('buy.unitPrice', { unit })}`}
                      value={toDisplayPrice(
                        draft.splitPrices.get(store.id) ?? draft.unitPrice,
                        priceInThousands,
                      )}
                      onChange={(e) => {
                        const splitPrices = new Map(draft.splitPrices);
                        splitPrices.set(
                          store.id,
                          fromDisplayPrice(e.target.value, priceInThousands),
                        );
                        onChange({ ...draft, splitPrices });
                      }}
                      onFocus={(e) => e.currentTarget.select()}
                      suffix={priceSuffix}
                    />
                    <ChoiceGroup<PaymentMethod>
                      compact
                      label={`${store.name} · ${i18n.t('run.label.paymentMethod')}`}
                      value={draft.splitPaymentMethods.get(store.id) ?? draft.paymentMethod}
                      onChange={(method) => {
                        const splitPaymentMethods = new Map(draft.splitPaymentMethods);
                        splitPaymentMethods.set(store.id, method);
                        onChange({ ...draft, splitPaymentMethods });
                      }}
                      options={paymentOptions}
                    />
                  </>
                ) : null}
              </div>
            );
          })}
        </section>

        <List>
          <Row
            action
            data-testid="toggle-store-pricing"
            title={
              draft.perStorePricing
                ? i18n.t('run.purchase.pricingUniform')
                : i18n.t('run.purchase.pricingPerStore')
            }
            onPress={togglePerStore}
          />
          {suppliers.length > 0 ? (
            <Row
              data-testid="pick-stall"
              title={i18n.t('run.action.supplier')}
              detail={stall?.name ?? i18n.t('buy.noStall')}
              onPress={() => setPickingStall((open) => !open)}
            />
          ) : null}
        </List>
        {pickingStall ? (
          <List>
            {suppliers.map((s) => (
              <Row
                key={s.id}
                picks
                title={s.name}
                value={s.id === draft.supplierId ? chosen : undefined}
                onPress={() => {
                  onChange({ ...draft, supplierId: s.id });
                  setPickingStall(false);
                }}
              />
            ))}
            <Row
              picks
              title={i18n.t('buy.noStall')}
              value={draft.supplierId === null ? chosen : undefined}
              onPress={() => {
                onChange({ ...draft, supplierId: null });
                setPickingStall(false);
              }}
            />
          </List>
        ) : null}

        {draft.isEdit ? (
          <Field
            label={i18n.t('run.label.reasonForChange') as string}
            value={draft.reason}
            onChange={(e) => onChange({ ...draft, reason: e.target.value })}
            placeholder={i18n.t('run.label.reasonPlaceholder') as string}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
