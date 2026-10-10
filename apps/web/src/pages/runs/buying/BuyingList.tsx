import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  ChoiceGroup,
  Field,
  List,
  Money,
  PaymentChip,
  Row,
  Section,
  Sheet,
  StatusChip,
} from '@compass/ui/kit';
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
  /**
   * The stall the purchase was made at. Known only when the list is
   * grouped by stall, where the purchaser is working through one stall's
   * lines; otherwise left out rather than guessed from the usual stall.
   */
  supplierId?: string | null;
}

/** How the lines still to buy are grouped. Stored per device. */
export type Grouping = 'aggregate' | 'perVendor' | 'perCategory' | 'perStore';
const GROUPING_KEY = 'compass.run.viewMode';

function readGrouping(): Grouping {
  try {
    const saved = localStorage.getItem(GROUPING_KEY);
    if (saved === 'perVendor' || saved === 'perCategory' || saved === 'perStore') return saved;
  } catch {
    /* storage is unavailable: start ungrouped */
  }
  return 'aggregate';
}

interface Group {
  key: string;
  /** Empty for the ungrouped list, which needs no heading. */
  name: string;
  /** Lines with no stall or category sort after the named groups. */
  unnamed: boolean;
  lines: Array<{ item: Item; qty: string }>;
}

export interface BuyingListProps {
  run: ActiveRun;
  skuById: Map<
    string,
    { names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  categoryById: Map<string, { names: Record<string, string> }>;
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
  /** Switch a bought line between cash and transfer, nothing else. */
  onSetPaymentMethod: (item: Item, next: PaymentMethod) => void;
  paymentBusySkuId: string | null;
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
 *
 * The lines still to buy can be grouped by stall, category or store,
 * because that is how a market is walked. What has been bought is a
 * record and stays one list. Grouped by store, a product appears once
 * per store that asked for it, so those rows open the sheet and carry no
 * one-tap button: one tap there would buy every store's share.
 */
export function BuyingList({
  run,
  skuById,
  categoryById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  onTogglePriceUnit,
  savingSkuId,
  onSave,
  onMarkNa,
  onEditPurchased,
  onSetPaymentMethod,
  paymentBusySkuId,
  onUnmark,
  onOpenAdvanced,
}: BuyingListProps) {
  const unitLabel = useUnitLabel();
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const [query, setQuery] = useState('');
  const [openSkuId, setOpenSkuId] = useState<string | null>(null);
  const [boughtSkuId, setBoughtSkuId] = useState<string | null>(null);
  const [grouping, setGroupingState] = useState<Grouping>(readGrouping);
  const setGrouping = (next: Grouping) => {
    setGroupingState(next);
    try {
      localStorage.setItem(GROUPING_KEY, next);
    } catch {
      /* the choice just does not outlive this visit */
    }
  };

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

  // A way of grouping is offered only when it would make more than one group.
  const groupings = useMemo(() => {
    const stalls = new Set(run.items.map((it) => run.supplierBySku?.[it.skuId]?.id ?? ''));
    const categories = new Set(run.items.map((it) => skuById.get(it.skuId)?.categoryId ?? ''));
    const stores = new Set((run.perStoreDemand ?? []).map((d) => d.storeId));
    const options: Array<{ value: Grouping; label: string }> = [];
    if (stalls.size > 1) {
      options.push({ value: 'perVendor', label: i18n.t('buy.group.stall') as string });
    }
    if (categories.size > 1) {
      options.push({ value: 'perCategory', label: i18n.t('buy.group.category') as string });
    }
    if (stores.size > 1) {
      options.push({ value: 'perStore', label: i18n.t('buy.group.store') as string });
    }
    if (options.length === 0) return options;
    return [{ value: 'aggregate' as Grouping, label: i18n.t('buy.group.none') as string }, ...options];
  }, [run.items, run.supplierBySku, run.perStoreDemand, skuById, i18n]);
  const activeGrouping = groupings.some((g) => g.value === grouping) ? grouping : 'aggregate';

  const groups = useMemo((): Group[] => {
    if (activeGrouping === 'aggregate') {
      return [
        {
          key: 'all',
          name: '',
          unnamed: false,
          lines: toBuy.map((item) => ({ item, qty: item.plannedQty })),
        },
      ];
    }
    const byKey = new Map<string, Group>();
    const add = (key: string | null, name: string, item: Item, qty: string) => {
      const group = byKey.get(key ?? '') ?? { key: key ?? '', name, unnamed: !key, lines: [] };
      group.lines.push({ item, qty });
      byKey.set(key ?? '', group);
    };
    for (const item of toBuy) {
      if (activeGrouping === 'perVendor') {
        const stall = run.supplierBySku?.[item.skuId] ?? null;
        add(
          stall?.id ?? null,
          stall?.name ?? (i18n.t('run.previewSupplier.unassigned') as string),
          item,
          item.plannedQty,
        );
      } else if (activeGrouping === 'perCategory') {
        const id = skuById.get(item.skuId)?.categoryId ?? null;
        const category = id ? categoryById.get(id) : undefined;
        add(
          category ? id : null,
          category ? productName(category) : (i18n.t('run.view.uncategorized') as string),
          item,
          item.plannedQty,
        );
      } else {
        for (const d of demandBySku.get(item.skuId) ?? []) {
          add(d.storeId, storeById.get(d.storeId)?.name ?? d.storeId.slice(0, 8), item, d.qty);
        }
      }
    }
    return [...byKey.values()].sort(
      (a, b) => Number(a.unnamed) - Number(b.unnamed) || a.name.localeCompare(b.name),
    );
  }, [
    activeGrouping,
    toBuy,
    run.supplierBySku,
    skuById,
    categoryById,
    storeById,
    demandBySku,
    productName,
    i18n,
  ]);

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
      ...(activeGrouping === 'perVendor'
        ? { supplierId: run.supplierBySku?.[it.skuId]?.id ?? null }
        : {}),
    });
  };

  const paymentLabel = (method: string): string =>
    i18n.t(method === 'transfer' ? 'run.label.paymentTransfer' : 'run.label.paymentCash') as string;

  const boughtTotal = bought.reduce(
    (sum, it) => sum + settleItemLine(it, splitsBySku.get(it.skuId) ?? []).line,
    0,
  );

  const quantity = (it: Item, qty: string | null, ofOneStore = false): string => {
    const stores = ofOneStore ? 1 : (demandBySku.get(it.skuId)?.length ?? 0);
    const base = `${formatQty(qty)} ${unitOf(it)}`;
    return stores > 1 ? `${base} · ${i18n.t('buy.stores', { n: stores })}` : base;
  };

  const boughtItem = boughtSkuId ? run.items.find((it) => it.skuId === boughtSkuId) : undefined;
  const methodsOf = (it: Item): string[] => {
    const methods = [
      ...new Set((splitsBySku.get(it.skuId) ?? []).map((sp) => splitPaymentMethod(sp, it))),
    ];
    return methods.length > 0 ? methods : [it.paymentMethod ?? 'cash'];
  };

  const buyRow = (it: Item, qty: string, perStore: boolean) => {
    const lastPrice = run.lastPriceBySku?.[it.skuId] ?? null;
    const saving = savingSkuId === it.skuId;
    const oneTap = perStore
      ? null
      : collapsedCommit({ status: it.status, saving, plannedQty: it.plannedQty, lastPrice });
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
            {quantity(it, qty, perStore)}
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
          perStore ? undefined : oneTap ? (
            <Button
              inline
              busy={saving}
              data-testid="buy-at-last-price"
              aria-label={i18n.t('buy.action.boughtAria', { name }) as string}
              onClick={() =>
                save(it, { qty: oneTap.qty, unitPrice: oneTap.price, paymentMethod: 'cash' })
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

      {groupings.length > 0 && toBuy.length > 0 ? (
        <ChoiceGroup<Grouping>
          compact
          label={i18n.t('run.view.ariaLabel') as string}
          value={activeGrouping}
          onChange={setGrouping}
          options={groupings}
        />
      ) : null}

      {toBuy.length > 0 ? (
        <Section
          title={i18n.t('buy.toBuy') as string}
          summary={<span className="text-body text-secondary">{toBuy.length}</span>}
        >
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-sm" data-testid="buy-group">
              {group.name ? (
                <h3 className="flex items-baseline justify-between gap-lg pt-sm text-label text-secondary">
                  <span className="min-w-0">{group.name}</span>
                  <span className="shrink-0">{group.lines.length}</span>
                </h3>
              ) : null}
              <List>
                {group.lines.map(({ item, qty }) =>
                  buyRow(item, qty, activeGrouping === 'perStore'),
                )}
              </List>
            </div>
          ))}
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
              const methods = methodsOf(it);
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
                  onPress={() => setBoughtSkuId(it.skuId)}
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

      {boughtItem && boughtItem.status === 'purchased' ? (
        <Sheet
          open
          onOpenChange={(open) => !open && setBoughtSkuId(null)}
          title={nameOf(boughtItem)}
          actions={
            <Button
              onClick={() => {
                setBoughtSkuId(null);
                onEditPurchased(boughtItem);
              }}
            >
              {i18n.t('buy.editPurchase')}
            </Button>
          }
        >
          <div className="flex flex-col gap-lg">
            <div className="flex items-baseline justify-between gap-lg">
              <span className="text-body text-secondary">
                {`${quantity(boughtItem, boughtItem.purchasedQty)} × ${formatMoney(boughtItem.unitPrice)}`}
              </span>
              <Money
                amount={formatMoney(
                  settleItemLine(boughtItem, splitsBySku.get(boughtItem.skuId) ?? []).line,
                )}
                currency={currency}
                size="lg"
              />
            </div>
            {/* Paid part in cash and part by transfer: there is no single
                switch to offer, the full editor has one per store. */}
            {methodsOf(boughtItem).length === 1 ? (
              <div
                className={paymentBusySkuId === boughtItem.skuId ? 'opacity-60' : undefined}
                aria-busy={paymentBusySkuId === boughtItem.skuId || undefined}
              >
                <ChoiceGroup<PaymentMethod>
                  label={i18n.t('run.label.paymentMethod') as string}
                  value={methodsOf(boughtItem)[0] === 'transfer' ? 'transfer' : 'cash'}
                  onChange={(next) => {
                    if (paymentBusySkuId) return;
                    if (next !== methodsOf(boughtItem)[0]) onSetPaymentMethod(boughtItem, next);
                  }}
                  options={[
                    { value: 'cash', label: i18n.t('run.label.paymentCash') as string },
                    { value: 'transfer', label: i18n.t('run.label.paymentTransfer') as string },
                  ]}
                />
              </div>
            ) : (
              <p className="text-body text-secondary">{i18n.t('buy.paidBothWays')}</p>
            )}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
