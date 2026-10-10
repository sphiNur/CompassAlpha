import { useEffect, useMemo, useState } from 'react';
import { Button, Field, List, Money, PaymentChip, Row, Section, StatusChip } from '@compass/ui/kit';
import type { PaymentMethod } from '@compass/ui/kit';
import { useAuthStore } from '../../../stores/authStore';
import type { useI18n } from '../../../hooks/useI18n';
import { useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney, formatQty } from '../../../lib/format';
import { normalizeQuery } from '../../../lib/searchMatch';
import type { ActiveRun } from '../types';
import { visibleItems, type ItemView } from '../lib/itemList';
import { AGING_DAYS, collapsedCommit, priceAgeDays } from '../lib/priceState';
import { settleItemLine, splitPaymentMethod } from '../lib/settlement';
import { proportionalSplitQty } from '../lib/splitQty';
import { QuickPurchaseSheet, type QuickPurchase } from './QuickPurchaseSheet';

type Item = ActiveRun['items'][number];
type Demand = Array<{ storeId: string; qty: string }>;

export interface PurchasePayload {
  skuId: string;
  actualQty: string;
  unitPrice: string;
  storeSplits: Array<{ storeId: string; qty: string }>;
  paymentMethod: PaymentMethod;
}

export interface BuyingListProps {
  run: ActiveRun;
  skuById: Map<string, { names: Record<string, string>; unit: string; step: string }>;
  storeById: Map<string, { name: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  /** Prices are typed in thousands ("12" for 12,000) when this is on. */
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  savingSkuId: string | null;
  onSave: (purchase: PurchasePayload) => void;
  onMarkNa: (skuId: string) => void;
  onEditPurchased: (item: Item) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  /** Per-store prices, supplier and receipt live in the full editor. */
  onOpenAdvanced: (item: Item) => void;
}

/**
 * A market trip as a list that shrinks: what is still to buy at the top,
 * what has been bought (with what it cost and how it was paid) below,
 * and what could not be had last.
 *
 * A trip is 80-odd lines, most of them bought at the price they were
 * last time, so the common case is one tap: "Bought" records the planned
 * quantity at the last price, in cash. Anything else — a different
 * price, a different quantity, a transfer, nothing to be had — is one
 * tap on the row and a sheet.
 */
export function BuyingList({
  run,
  skuById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  onTogglePriceUnit,
  savingSkuId,
  onSave,
  onMarkNa,
  onEditPurchased,
  onUnmark,
  onOpenAdvanced,
}: BuyingListProps) {
  const unitLabel = useUnitLabel();
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const [query, setQuery] = useState('');
  const [openSkuId, setOpenSkuId] = useState<string | null>(null);

  const demandBySku = useMemo(() => {
    const m = new Map<string, Demand>();
    for (const d of run.perStoreDemand ?? []) {
      const rows = m.get(d.skuId) ?? [];
      rows.push({ storeId: d.storeId, qty: d.qty });
      m.set(d.skuId, rows);
    }
    return m;
  }, [run.perStoreDemand]);

  const splitsBySku = useMemo(() => {
    const m = new Map<string, ActiveRun['splits']>();
    for (const sp of run.splits) {
      const rows = m.get(sp.skuId) ?? [];
      rows.push(sp);
      m.set(sp.skuId, rows);
    }
    return m;
  }, [run.splits]);

  const nameOf = (it: Item): string => {
    const sku = skuById.get(it.skuId);
    return sku ? productName(sku) : it.skuId.slice(0, 8);
  };
  const unitOf = (it: Item): string => unitLabel(skuById.get(it.skuId)?.unit);

  const view = useMemo(
    (): ItemView<Item> => ({
      nameOf: (it) => {
        const sku = skuById.get(it.skuId);
        return sku ? productName(sku) : it.skuId;
      },
      supplierNameOf: (it) => run.supplierBySku?.[it.skuId]?.name ?? null,
      // Every language's name, so a search in one finds a list shown in another.
      extraHaystackOf: (it) => Object.values(skuById.get(it.skuId)?.names ?? {}),
      statusOf: (it) => it.status,
      idOf: (it) => it.skuId,
    }),
    [skuById, productName, run.supplierBySku],
  );
  const shown = useMemo(
    () => visibleItems(run.items, view, { tokens: normalizeQuery(query) ?? [], filter: 'all' }),
    [run.items, view, query],
  );
  const toBuy = shown.filter((it) => it.status === 'pending');
  const bought = shown.filter((it) => it.status === 'purchased');
  const unavailable = shown.filter((it) => it.status === 'unavailable');

  const openItem = openSkuId ? run.items.find((it) => it.skuId === openSkuId) : undefined;
  // The sheet belongs to a line that is still to buy. Once the save lands
  // and the line moves down the list, it has nothing left to ask.
  useEffect(() => {
    if (openItem && openItem.status !== 'pending') setOpenSkuId(null);
  }, [openItem]);

  const save = (it: Item, purchase: QuickPurchase) => {
    const splits = proportionalSplitQty(demandBySku.get(it.skuId) ?? [], purchase.qty);
    // No store asked for this line (the purchaser added it): who gets it
    // is a question only the full editor can ask.
    if (!splits || splits.length === 0) {
      setOpenSkuId(null);
      onOpenAdvanced(it);
      return;
    }
    onSave({
      skuId: it.skuId,
      actualQty: purchase.qty,
      unitPrice: purchase.unitPrice,
      paymentMethod: purchase.paymentMethod,
      storeSplits: splits,
    });
  };

  const paymentLabel = (method: string): string =>
    i18n.t(method === 'transfer' ? 'run.label.paymentTransfer' : 'run.label.paymentCash') as string;

  const boughtTotal = bought.reduce(
    (sum, it) => sum + settleItemLine(it, splitsBySku.get(it.skuId) ?? []).line,
    0,
  );

  const quantity = (it: Item, qty: string | null): string => {
    const stores = demandBySku.get(it.skuId)?.length ?? 0;
    const base = `${formatQty(qty)} ${unitOf(it)}`;
    return stores > 1 ? `${base} · ${i18n.t('buy.stores', { n: stores })}` : base;
  };

  return (
    <div className="flex flex-col gap-xl">
      {run.items.length >= 8 ? (
        <Field
          type="search"
          label={i18n.t('run.search.itemsPlaceholder') as string}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}

      {shown.length === 0 ? (
        <p className="text-body text-secondary">{i18n.t('run.filter.noMatch')}</p>
      ) : null}

      {toBuy.length > 0 ? (
        <Section
          title={i18n.t('buy.toBuy') as string}
          summary={<span className="text-body text-secondary">{toBuy.length}</span>}
        >
          <List>
            {toBuy.map((it) => {
              const lastPrice = run.lastPriceBySku?.[it.skuId] ?? null;
              const saving = savingSkuId === it.skuId;
              const oneTap = collapsedCommit({
                status: it.status,
                saving,
                plannedQty: it.plannedQty,
                lastPrice,
              });
              const age = priceAgeDays(run.lastPriceObservedAtBySku?.[it.skuId], Date.now());
              const old = age !== null && age > AGING_DAYS;
              const name = nameOf(it);
              return (
                <Row
                  key={it.skuId}
                  data-testid="buy-row"
                  title={name}
                  detail={
                    <>
                      {quantity(it, it.plannedQty)}
                      {lastPrice ? (
                        <span className={old ? 'text-warning-ink' : undefined}>
                          {' · '}
                          {i18n.t('buy.lastPrice', { price: formatMoney(lastPrice) })}
                          {old ? ` (${i18n.t('run.price.daysAgo', { n: age })})` : null}
                        </span>
                      ) : null}
                    </>
                  }
                  onPress={() => setOpenSkuId(it.skuId)}
                  trailing={
                    oneTap ? (
                      <Button
                        inline
                        busy={saving}
                        data-testid="buy-at-last-price"
                        aria-label={i18n.t('buy.action.boughtAria', { name }) as string}
                        onClick={() =>
                          save(it, {
                            qty: oneTap.qty,
                            unitPrice: oneTap.price,
                            paymentMethod: 'cash',
                          })
                        }
                      >
                        {i18n.t('buy.action.bought')}
                      </Button>
                    ) : (
                      <Button inline busy={saving} onClick={() => setOpenSkuId(it.skuId)}>
                        {i18n.t('run.price.fillIn')}
                      </Button>
                    )
                  }
                />
              );
            })}
          </List>
        </Section>
      ) : null}

      {bought.length > 0 ? (
        <Section
          title={i18n.t('buy.bought') as string}
          summary={<Money amount={formatMoney(boughtTotal)} currency={currency} />}
        >
          <List>
            {bought.map((it) => {
              const splits = splitsBySku.get(it.skuId) ?? [];
              const methods = [...new Set(splits.map((sp) => splitPaymentMethod(sp, it)))];
              if (methods.length === 0) methods.push(it.paymentMethod ?? 'cash');
              return (
                <Row
                  key={it.skuId}
                  data-testid="bought-row"
                  title={nameOf(it)}
                  detail={`${quantity(it, it.purchasedQty)} × ${formatMoney(it.unitPrice)}`}
                  value={<Money amount={formatMoney(settleItemLine(it, splits).line)} />}
                  valueNote={
                    <span className="flex gap-xs">
                      {methods.map((m) => (
                        <PaymentChip
                          key={m}
                          method={m === 'transfer' ? 'transfer' : 'cash'}
                          label={paymentLabel(m)}
                        />
                      ))}
                    </span>
                  }
                  onPress={() => onEditPurchased(it)}
                />
              );
            })}
          </List>
        </Section>
      ) : null}

      {unavailable.length > 0 ? (
        <Section
          title={i18n.t('buy.unavailable') as string}
          summary={<span className="text-body text-secondary">{unavailable.length}</span>}
        >
          <List>
            {unavailable.map((it) => (
              <Row
                key={it.skuId}
                data-testid="unavailable-row"
                title={nameOf(it)}
                detail={
                  it.unavailableNote
                    ? `${quantity(it, it.plannedQty)} · ${it.unavailableNote}`
                    : quantity(it, it.plannedQty)
                }
                value={<StatusChip tone="problem">{i18n.t('buy.unavailable')}</StatusChip>}
                onPress={() => onUnmark(it.skuId, nameOf(it))}
              />
            ))}
          </List>
        </Section>
      ) : null}

      {openItem && openItem.status === 'pending' ? (
        <QuickPurchaseSheet
          key={openItem.skuId}
          name={nameOf(openItem)}
          unit={unitOf(openItem)}
          plannedQty={openItem.plannedQty}
          lastPrice={run.lastPriceBySku?.[openItem.skuId] ?? null}
          demand={(demandBySku.get(openItem.skuId) ?? []).map((d) => ({
            storeName: storeById.get(d.storeId)?.name ?? d.storeId.slice(0, 8),
            qty: d.qty,
          }))}
          currency={currency}
          priceInThousands={priceInThousands}
          onTogglePriceUnit={onTogglePriceUnit}
          saving={savingSkuId === openItem.skuId}
          i18n={i18n}
          onClose={() => setOpenSkuId(null)}
          onSave={(purchase) => save(openItem, purchase)}
          onMarkNa={() => {
            setOpenSkuId(null);
            onMarkNa(openItem.skuId);
          }}
          onOpenAdvanced={() => {
            setOpenSkuId(null);
            onOpenAdvanced(openItem);
          }}
        />
      ) : null}
    </div>
  );
}
