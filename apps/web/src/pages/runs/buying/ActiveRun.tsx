import { Button } from '@compass/ui/kit';
import type { PaymentMethod } from '@compass/ui/kit';
import type { useI18n } from '../../../hooks/useI18n';
import type { ActiveRun } from '../types';
import { BuyingList, type PurchasePayload } from './BuyingList';
import { DeliveryList } from './DeliveryList';
import { OtherSpending, RequestedExtras } from './RunExtras';

type Item = ActiveRun['items'][number];

export interface ActiveRunPanelProps {
  run: ActiveRun;
  skuById: Map<
    string,
    { names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  categoryById: Map<string, { names: Record<string, string> }>;
  storeById: Map<string, { name: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  savingSkuId: string | null;
  onSavePurchase: (purchase: PurchasePayload) => void;
  onMarkNa: (skuId: string) => void;
  onEditPurchased: (item: Item) => void;
  onSetPaymentMethod: (item: Item, next: PaymentMethod) => void;
  paymentBusySkuId: string | null;
  onUnmark: (skuId: string, skuName: string) => void;
  onOpenAdvancedPurchase: (item: Item) => void;
  onDeliverStore: (storeId: string, storeName: string) => void;
  onRecallStore: (storeId: string, storeName: string) => void;
  onMarkExtraStatus: (
    sessionId: string,
    extraIndex: number,
    status: 'pending' | 'bought' | 'unavailable',
  ) => void;
  onRecordExtraExpense: (
    storeId: string,
    extra: { name: string; qty: string; unit: string; note?: string },
  ) => void;
  onRemoveExpense: (expenseId: string) => void;
  onAddItem: () => void;
  onAddExpense: () => void;
}

/**
 * A trip that has started. While buying (or while an administrator is
 * correcting a finished trip, which is the same screen) it is the buying
 * list, then what stores asked for off the catalogue, then other
 * spending, and last the two ways to add something that was not planned.
 * Once delivery starts it is the list of stores, with the spending kept
 * below as a record.
 */
export function ActiveRunPanel({
  run,
  skuById,
  categoryById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  onTogglePriceUnit,
  savingSkuId,
  onSavePurchase,
  onMarkNa,
  onEditPurchased,
  onSetPaymentMethod,
  paymentBusySkuId,
  onUnmark,
  onOpenAdvancedPurchase,
  onDeliverStore,
  onRecallStore,
  onMarkExtraStatus,
  onRecordExtraExpense,
  onRemoveExpense,
  onAddItem,
  onAddExpense,
}: ActiveRunPanelProps) {
  const editing = run.status === 'purchasing' || run.status === 'amending';

  return (
    <div className="flex flex-col gap-xl">
      {run.status === 'delivering' ? (
        <DeliveryList
          run={run}
          storeById={storeById}
          i18n={i18n}
          onDeliver={onDeliverStore}
          onRecall={onRecallStore}
        />
      ) : null}

      {editing && run.items.length > 0 ? (
        <BuyingList
          run={run}
          skuById={skuById}
          categoryById={categoryById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          priceInThousands={priceInThousands}
          onTogglePriceUnit={onTogglePriceUnit}
          savingSkuId={savingSkuId}
          onSave={onSavePurchase}
          onMarkNa={onMarkNa}
          onEditPurchased={onEditPurchased}
          onSetPaymentMethod={onSetPaymentMethod}
          paymentBusySkuId={paymentBusySkuId}
          onUnmark={onUnmark}
          onOpenAdvanced={onOpenAdvancedPurchase}
        />
      ) : null}

      {editing ? (
        <RequestedExtras
          extrasByStore={run.sessionExtrasByStore}
          notesByStore={run.sessionNotesByStore}
          storeById={storeById}
          i18n={i18n}
          editable
          onMarkStatus={onMarkExtraStatus}
          onRecordPrice={onRecordExtraExpense}
        />
      ) : null}

      <OtherSpending
        expenses={run.expenses}
        storeById={storeById}
        i18n={i18n}
        editable={editing}
        onRemove={onRemoveExpense}
      />

      {editing ? (
        <div className="flex gap-sm">
          <Button data-testid="add-item" onClick={onAddItem}>
            {i18n.t('buy.addItem')}
          </Button>
          <Button data-testid="add-expense" onClick={onAddExpense}>
            {i18n.t('buy.addExpense')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
