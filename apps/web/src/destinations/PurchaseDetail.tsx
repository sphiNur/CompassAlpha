import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field, PaymentChip, Sheet, StatusChip } from '@compass/ui/kit';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n, useProductName, useUnitLabel } from '../hooks/useI18n';
import { useErrToast } from '../lib/errToast';
import { currencyOf, formatMoney, formatQty } from '../lib/format';
import { settleItemLine, settlePerStore, splitSubtotal } from '../pages/runs/lib/settlement';
import { ChevronIcon } from './icons';

export interface PurchaseTarget {
  runId: string;
  runIndex: number;
  runDate: string;
  /** Opened from a store's row: start on that store's share. */
  storeId?: string | null;
}

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70';

function Disc({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-surface text-label text-ink"
    >
      {Array.from(name.trim())[0] ?? ''}
    </span>
  );
}

/**
 * One finished purchase: what it came to, what was bought at what price,
 * and each store's share, which is what a store is charged.
 *
 * A store's figures are strictly its own slice: its lines and its part
 * of any shared cost, never another store's. The sums are the same
 * functions the purchaser's finishing summary uses.
 *
 * Two corrections live at the bottom for those the server says may make
 * them: the day the spend is booked under, and reopening the purchase.
 */
export function PurchaseDetail({
  target,
  onClose,
}: {
  target: PurchaseTarget | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const productName = useProductName();
  const unitLabel = useUnitLabel();
  const session = useAuthStore((s) => s.session);
  const currency = currencyOf(session);
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();

  const detail = trpc.run.historyDetail.useQuery(
    { runId: target?.runId ?? '' },
    { enabled: !!target },
  );
  // Archived products too: a purchase keeps the name of what was bought.
  const skus = trpc.catalog.skus.useQuery({ includeArchived: true }, { enabled: !!target });
  const stores = trpc.catalog.stores.useQuery({ permission: 'prices.view' }, { enabled: !!target });
  const skuById = useMemo(() => new Map((skus.data ?? []).map((s) => [s.id, s])), [skus.data]);
  const storeName = (id: string) =>
    stores.data?.find((st) => st.id === id)?.name.trim() || id.slice(0, 8);

  const [storeId, setStoreId] = useState<string | null>(null);
  const [fixing, setFixing] = useState<'date' | 'reopen' | null>(null);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setStoreId(target?.storeId ?? null);
    setFixing(null);
    setDate(target?.runDate ?? '');
    setReason('');
  }, [target?.runId, target?.storeId, target?.runDate]);

  // Moving the day touches no money, so it does not reopen the purchase.
  const changeDate = trpc.run.changeDate.useMutation({
    onSuccess: () => {
      void utils.run.invalidate();
      toast.success(i18n.t('run.date.changed'));
      onClose();
    },
    onError: errToast('common.error'),
  });
  // Reopening hands it back to the buying screen, where the correction
  // is made and closed.
  const reopen = trpc.run.reopen.useMutation({
    onSuccess: () => {
      void utils.run.invalidate();
      toast.success(i18n.t('run.amend.reopened'));
      onClose();
    },
    onError: errToast('common.error'),
  });

  const sums = useMemo(() => {
    if (!detail.data) return null;
    const { items, splits } = detail.data;
    const expenses = detail.data.expenses ?? [];
    let total = 0;
    let cash = 0;
    let transfer = 0;
    for (const item of items) {
      const own = splits.filter((sp) => sp.skuId === item.skuId);
      if (
        item.status === 'purchased' &&
        item.purchasedQty &&
        (item.unitPrice || own.some((sp) => sp.unitPrice))
      ) {
        const line = settleItemLine(item, own);
        total += line.line;
        cash += line.cash;
        transfer += line.transfer;
      }
    }
    for (const ex of expenses) {
      const line = Number(ex.qty) * Number(ex.unitPrice);
      total += line;
      if (ex.paymentMethod === 'transfer') transfer += line;
      else cash += line;
    }
    return { total, cash, transfer, perStore: settlePerStore(items, splits, expenses) };
  }, [detail.data]);

  const data = detail.data;
  const shares = sums ? [...sums.perStore.values()].sort((a, b) => b.total - a.total) : [];
  const store = storeId && sums?.perStore.has(storeId) ? storeId : null;
  const share = store ? sums!.perStore.get(store)! : null;
  const head = share ?? sums;

  // What to list: everything, or one store's slice of it.
  const lines = (data?.items ?? []).flatMap((item) => {
    const own = (data?.splits ?? []).filter((sp) => sp.skuId === item.skuId);
    if (!store) {
      const priced = item.unitPrice || own.some((sp) => sp.unitPrice);
      const amount =
        item.status === 'purchased' && item.purchasedQty && priced
          ? own.reduce((sum, sp) => sum + splitSubtotal(sp, item), 0) ||
            Number(item.unitPrice) * Number(item.purchasedQty)
          : 0;
      return [{ item, qty: item.purchasedQty, price: item.unitPrice, amount, own }];
    }
    if (item.status === 'purchased') {
      const mine = own.find((sp) => sp.storeId === store);
      if (!mine) return [];
      return [
        {
          item,
          qty: mine.qty,
          price: mine.unitPrice ?? item.unitPrice,
          amount: splitSubtotal(mine, item),
          own: [mine],
        },
      ];
    }
    const asked = (data?.perStoreDemand ?? []).find(
      (d) => d.storeId === store && d.skuId === item.skuId,
    );
    return asked ? [{ item, qty: asked.qty, price: null, amount: 0, own: [] }] : [];
  });
  const spending = (data?.expenses ?? []).flatMap((ex) => {
    if (!store) return [{ ex, qty: ex.qty }];
    const mine = ex.storeSplits.find((sp) => sp.storeId === store);
    return mine ? [{ ex, qty: mine.qty }] : [];
  });
  const bought = lines.filter((l) => l.item.status === 'purchased').length;
  const missed = lines.filter((l) => l.item.status === 'unavailable').length;

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      title={
        target ? `${target.runDate}${target.runIndex > 0 ? ` #${target.runIndex + 1}` : ''}` : ''
      }
    >
      {!target ? null : detail.isPending ? (
        <p className="text-body text-secondary">{i18n.t('run.history.loadingDetails')}</p>
      ) : !data || !sums || !head ? (
        <p className="text-body text-secondary">{i18n.t('common.noData')}</p>
      ) : (
        <div className="flex flex-col gap-xl">
          {shares.length > 1 ? (
            <div className="-mx-page flex gap-sm overflow-x-auto px-page">
              {[null, ...shares.map((s) => s.storeId)].map((id) => (
                <button
                  key={id ?? 'all'}
                  type="button"
                  aria-pressed={store === id}
                  data-testid="purchase-store"
                  onClick={() => setStoreId(id)}
                  className={cn(
                    CAPSULE,
                    store === id ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink',
                  )}
                >
                  {id ? storeName(id) : i18n.t('run.history.allStores')}
                </button>
              ))}
            </div>
          ) : null}

          <div data-testid="purchase-total" className="flex flex-col gap-xs">
            <span className="text-small text-secondary">
              {[store ? storeName(store) : null, i18n.t('run.history.totalLabel')]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-sm text-ink" dir="ltr">
              <span className="text-display tabular-nums">{formatMoney(head.total)}</span>
              <span className="text-label text-secondary">{currency}</span>
            </span>
            <span className="text-small text-secondary">
              {i18n.t('run.label.paymentCash')}{' '}
              <span dir="ltr" className="tabular-nums text-ink">
                {formatMoney(head.cash)}
              </span>
              {' · '}
              {i18n.t('run.label.paymentTransfer')}{' '}
              <span dir="ltr" className="tabular-nums text-ink">
                {formatMoney(head.transfer)}
              </span>
            </span>
            <span className="text-small text-secondary">
              {i18n.t('run.history.itemSummary', { bought, na: missed })}
            </span>
          </div>

          <section className="flex flex-col gap-sm">
            <h3 className="text-body text-secondary">{i18n.t('run.history.itemsHeading')}</h3>
            {lines.length === 0 ? (
              <p className="text-body text-secondary">{i18n.t('common.noData')}</p>
            ) : (
              <ul className="flex flex-col">
                {lines.map(({ item, qty, price, amount, own }) => {
                  const sku = skuById.get(item.skuId);
                  const name = sku
                    ? productName({ names: sku.names as Record<string, string> })
                    : item.skuId.slice(0, 8);
                  const unit = unitLabel(sku?.unit);
                  const got = item.status === 'purchased';
                  return (
                    <li
                      key={item.skuId}
                      data-testid="purchase-line"
                      className="flex min-h-row items-center gap-lg py-sm"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-label text-ink">{name}</span>
                        <span className="block text-small text-secondary" dir="ltr">
                          {got
                            ? `${formatQty(qty)} ${unit}${price ? ` × ${formatMoney(price)}` : ''}`
                            : `${formatQty(qty)} ${unit}`}
                        </span>
                        {!got && item.unavailableNote ? (
                          <span className="block text-small text-secondary">
                            {item.unavailableNote}
                          </span>
                        ) : null}
                        {/* Looking at every store: who got how much of it. */}
                        {!store && got && own.length > 1
                          ? own.map((sp) => (
                              <span key={sp.storeId} className="block text-small text-secondary">
                                {storeName(sp.storeId)}{' '}
                                <span dir="ltr" className="tabular-nums">
                                  {formatQty(sp.qty)} {unit}
                                </span>
                              </span>
                            ))
                          : null}
                      </span>
                      {got ? (
                        <span className="shrink-0 text-money tabular-nums text-ink" dir="ltr">
                          {formatMoney(amount)}
                        </span>
                      ) : (
                        <StatusChip tone="problem">{i18n.t('run.action.markNa')}</StatusChip>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {spending.length > 0 ? (
            <section className="flex flex-col gap-sm">
              <h3 className="text-body text-secondary">{i18n.t('buy.otherSpending')}</h3>
              <ul className="flex flex-col">
                {spending.map(({ ex, qty }) => (
                  <li
                    key={ex.id}
                    data-testid="purchase-spending"
                    className="flex min-h-row items-center gap-lg py-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-label text-ink">{ex.label}</span>
                      <span className="block text-small text-secondary" dir="ltr">
                        {formatQty(qty)} {ex.unitHint ?? ''} × {formatMoney(ex.unitPrice)}
                      </span>
                      {ex.reason ? (
                        <span className="block text-small text-secondary">{ex.reason}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-xs">
                      <span className="text-money tabular-nums text-ink" dir="ltr">
                        {formatMoney(Number(qty) * Number(ex.unitPrice))}
                      </span>
                      <PaymentChip
                        method={ex.paymentMethod === 'transfer' ? 'transfer' : 'cash'}
                        label={
                          i18n.t(
                            ex.paymentMethod === 'transfer'
                              ? 'run.label.paymentTransfer'
                              : 'run.label.paymentCash',
                          ) as string
                        }
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!store && shares.length > 1 ? (
            <section className="flex flex-col gap-sm">
              <h3 className="text-body text-secondary">{i18n.t('run.history.storesHeading')}</h3>
              {shares.map((s) => (
                <button
                  key={s.storeId}
                  type="button"
                  data-testid="purchase-share"
                  onClick={() => setStoreId(s.storeId)}
                  className="flex min-h-row items-center gap-lg py-sm text-start outline-none active:opacity-60"
                >
                  <Disc name={storeName(s.storeId)} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-label text-ink">{storeName(s.storeId)}</span>
                    <span className="block text-small text-secondary">
                      {[
                        i18n.t('run.label.itemsCount', { n: s.skuIds.size }),
                        s.cash > 0
                          ? `${i18n.t('run.label.paymentCash')} ${formatMoney(s.cash)}`
                          : null,
                        s.transfer > 0
                          ? `${i18n.t('run.label.paymentTransfer')} ${formatMoney(s.transfer)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-money tabular-nums text-ink" dir="ltr">
                    {formatMoney(s.total)}
                  </span>
                  <span className="shrink-0 text-forest">
                    <ChevronIcon />
                  </span>
                </button>
              ))}
            </section>
          ) : null}

          {/* Only the server's own answer for this purchase counts: the
              permission list in the session is a union across stores. */}
          {data.canAmend ? (
            <section className="flex flex-col gap-md">
              {fixing === 'date' ? (
                <>
                  <Field
                    type="date"
                    label={i18n.t('run.date.label') as string}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                  <p className="text-small text-secondary">{i18n.t('run.date.hint')}</p>
                  <Button
                    variant="secondary"
                    data-testid="purchase-date-save"
                    busy={changeDate.isPending}
                    disabled={!date || date === target.runDate}
                    onClick={() => changeDate.mutate({ runId: target.runId, runDate: date })}
                  >
                    {i18n.t('run.date.change')}
                  </Button>
                </>
              ) : fixing === 'reopen' ? (
                <>
                  <Field
                    label={i18n.t('run.amend.reasonPlaceholder') as string}
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    variant="secondary"
                    data-testid="purchase-reopen-save"
                    busy={reopen.isPending}
                    disabled={!reason.trim()}
                    onClick={() => reopen.mutate({ runId: target.runId, reason: reason.trim() })}
                  >
                    {i18n.t('run.amend.reopenButton')}
                  </Button>
                </>
              ) : (
                <div className="flex flex-wrap gap-sm">
                  <button
                    type="button"
                    data-testid="purchase-fix-date"
                    onClick={() => setFixing('date')}
                    className={cn(CAPSULE, 'bg-surface-sunken text-ink')}
                  >
                    {i18n.t('run.date.change')}
                  </button>
                  <button
                    type="button"
                    data-testid="purchase-fix-reopen"
                    onClick={() => setFixing('reopen')}
                    className={cn(CAPSULE, 'bg-surface-sunken text-ink')}
                  >
                    {i18n.t('run.amend.reopenButton')}
                  </button>
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
