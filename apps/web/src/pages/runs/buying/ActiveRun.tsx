import { List, Row } from '@compass/ui/kit';
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
  onDeliverStore: (storeId: string) => void;
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
  /** The store whose "delivered" is being saved right now. */
  deliveringStoreId: string | null;
  /** Each is present only while the step can still be taken back. */
  onBackToPlan?: () => void;
  onBackToBuying?: () => void;
  onCancelRun: () => void;
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
  deliveringStoreId,
  onBackToPlan,
  onBackToBuying,
  onCancelRun,
}: ActiveRunPanelProps) {
  const editing = run.status === 'purchasing' || run.status === 'amending';
  // Lines decided one way or the other: bought, or not to be had.
  const done = run.items.filter((item) => item.status !== 'pending').length;
  const left = run.items.length - done;

  return (
    <div className="flex flex-col gap-xl">
      {run.status === 'delivering' ? (
        <DeliveryList
          run={run}
          storeById={storeById}
          i18n={i18n}
          onDeliver={onDeliverStore}
          deliveringStoreId={deliveringStoreId}
          onRecall={onRecallStore}
        />
      ) : null}

      {/* What a purchaser looks up for between stalls: how much is left.
          The one large figure on the screen, with a bar under it. */}
      {editing && run.items.length > 0 ? (
        <div data-testid="buying-progress" className="flex flex-col gap-sm">
          <span className="text-display text-ink">
            {left > 0 ? i18n.t('buy.left', { n: left }) : i18n.t('buy.allBought')}
          </span>
          <span className="text-small text-secondary">
            {i18n.t('today.bought', { done, lines: run.items.length })}
          </span>
          <span aria-hidden className="flex h-sm overflow-hidden rounded-pill bg-surface-sunken">
            <span
              className="rounded-pill bg-primary"
              style={{ width: `${(done / run.items.length) * 100}%` }}
            />
          </span>
        </div>
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
        <List>
          <Row action data-testid="add-item" title={i18n.t('buy.addItem')} onPress={onAddItem} />
          <Row
            action
            data-testid="add-expense"
            title={i18n.t('buy.addExpense')}
            onPress={onAddExpense}
          />
        </List>
      ) : null}

      {/* Stepping back, and giving the trip up. These used to live only in
          Telegram's own menu, where nobody looked and a browser cannot
          reach. Each asks before it does anything. */}
      {run.status !== 'finished' ? (
        <List>
          {onBackToPlan ? (
            <Row
              data-testid="run-back-to-plan"
              title={i18n.t('run.action.undoStartPurchase')}
              onPress={onBackToPlan}
            />
          ) : null}
          {onBackToBuying ? (
            <Row
              data-testid="run-back-to-buying"
              title={i18n.t('run.action.undoStartDelivery')}
              onPress={onBackToBuying}
            />
          ) : null}
          <Row
            data-testid="run-cancel"
            title={<span className="text-danger">{i18n.t('run.action.cancelRun')}</span>}
            onPress={onCancelRun}
          />
        </List>
      ) : null}
    </div>
  );
}
