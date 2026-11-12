/**
 * The figures the finish and correction confirmations show above their
 * text, as rows: the run's total with its counts, the total's parts, how
 * it was paid, what was added, notes on the prices, each store's bill and
 * what the stores signed for short.
 *
 * Review RUNWEB1-08 (2026-11-12): the confirmation was one grey paragraph
 * of lines joined with '\n'. It said the total twice (in the summary and
 * in the money line) and the expenses twice (in the money line and in
 * their own line), the store bills could not line up, and ' · ' and the
 * label-amount-currency order were written in code. Each figure is a row
 * now, said once, and every separator and word order is the catalog's.
 * The numbers are finishSummary's, as before. Pure; tests in
 * __tests__/confirmCopy.test.ts.
 */
import type { I18n } from '@compass/i18n';
import { formatMoney, formatQty } from '../../../lib/format';
import type { ActiveRun } from '../types';
import { receiptShortfall, type FinishSummary } from './finishSummary';
import { STALE_PRICE_DAYS } from './priceState';

/** Lines signed short or wrong listed in the finish sheet; the rest are counted (RUNWEB1-32). */
export const RECEIPT_ISSUES_LISTED = 5;

/** A label and its figure. */
export interface SummaryRow {
  key: 'total' | 'items' | 'expenses' | 'cash' | 'transfer' | 'added';
  label: string;
  value: string;
}

/** One store's bill. */
export interface StoreBillRow {
  storeId: string;
  name: string;
  total: string;
  /** Its cash and transfer parts, when the store paid both ways. */
  paidBoth: string | null;
}

export interface ConfirmSummary {
  /** The total (with the counts) first, then its parts. */
  rows: SummaryRow[];
  /** Prices carried over from the last trip, and how many of those were old. */
  notes: string[];
  /** Each store's bill, largest first; a run for one store has none. */
  stores: StoreBillRow[];
  /** Lines the stores signed for short, wrong or spoiled. */
  receipt: { summary: string; lines: string[]; more: string | null } | null;
}

export interface ConfirmSummaryContext {
  i18n: I18n;
  /** run.get, with the writes still waiting offline laid over it. */
  run: Pick<ActiveRun, 'items' | 'splits'> | undefined;
  summary: FinishSummary;
  currency: string;
  storeName: (storeId: string) => string;
  skuName: (skuId: string) => string;
}

/**
 * 2026-10-21 CA-11: the one money definition, items / expenses / total.
 * Without expenses the items are the total, so the total row says it
 * alone.
 */
function moneyRows({ i18n, summary, currency }: ConfirmSummaryContext): SummaryRow[] {
  const rows: SummaryRow[] = [
    {
      key: 'total',
      label: i18n.t('run.confirm.finish.counts', {
        items: summary.skus,
        stores: summary.stores,
      }),
      value: i18n.t('common.amountWithCurrency', {
        amount: formatMoney(summary.money.total),
        currency,
      }),
    },
  ];
  if (summary.expensesCount > 0 || summary.money.expenses !== 0) {
    rows.push(
      {
        key: 'items',
        label: i18n.t('run.label.itemsTotal'),
        value: formatMoney(summary.money.items),
      },
      // M3.44 (2026-05-22): off-catalog expenses, counted.
      {
        key: 'expenses',
        label: i18n.t('run.confirm.finish.expensesCount', { n: summary.expensesCount }),
        value: formatMoney(summary.money.expenses),
      },
    );
  }
  return rows;
}

/** What closing the run locks in. */
export function finishConfirmSummary(ctx: ConfirmSummaryContext): ConfirmSummary {
  const { i18n, summary, currency } = ctx;
  const rows = moneyRows(ctx);
  // M1.14: cash and transfer when the run used both; a one-method run
  // has nothing to split.
  if (summary.totalCash > 0 && summary.totalTransfer > 0) {
    rows.push(
      {
        key: 'cash',
        label: i18n.t('run.label.paymentCash'),
        value: formatMoney(summary.totalCash),
      },
      {
        key: 'transfer',
        label: i18n.t('run.label.paymentTransfer'),
        value: formatMoney(summary.totalTransfer),
      },
    );
  }
  // M3.41 (2026-05-21): rows the purchaser added beyond the orders, so the
  // manager sees off-plan spending at a glance.
  if (summary.addedSkus > 0) {
    rows.push({
      key: 'added',
      label: i18n.t('run.confirm.finish.addedCount', { n: summary.addedSkus }),
      value: formatMoney(summary.addedTotal),
    });
  }
  // Q7(b) safety net (2026-07-26): hiding the price editor is defensible
  // only if closing a run says how many of its prices are just the last
  // trip's number again, and how many of those were already old. Every
  // accepted price becomes the next trip's reference.
  const notes =
    summary.carriedOver > 0
      ? [
          i18n.t('run.finish.carriedOver', { n: summary.carriedOver }),
          ...(summary.carriedOverStale > 0
            ? [
                i18n.t('run.finish.carriedOverStale', {
                  n: summary.carriedOverStale,
                  days: STALE_PRICE_DAYS,
                }),
              ]
            : []),
        ]
      : [];
  // M3.52 (2026-05-23): each store's own slice (its lines and its share of
  // the expenses), for a run of two stores or more; one store's bill is
  // the total.
  const stores =
    summary.byStore.length > 1
      ? summary.byStore.map(
          (ps): StoreBillRow => ({
            storeId: ps.storeId,
            name: ctx.storeName(ps.storeId),
            total: formatMoney(ps.total),
            paidBoth:
              ps.cash > 0 && ps.transfer > 0
                ? i18n.t('run.money.cashTransfer', {
                    cash: formatMoney(ps.cash),
                    transfer: formatMoney(ps.transfer),
                  })
                : null,
          }),
        )
      : [];
  // DLV-11 (2026-10-30): the bills still charge each store for what was
  // split to it, even where the store signed for less. Said before the
  // run locks: the lines signed short / wrong / spoiled, and roughly how
  // much was not received.
  const { issues, missingValue } = receiptShortfall(ctx.run);
  const receipt =
    issues.length > 0
      ? {
          summary: i18n.t('run.confirm.finish.receiptIssues', {
            n: issues.length,
            amount: formatMoney(missingValue),
            currency,
          }),
          lines: issues.slice(0, RECEIPT_ISSUES_LISTED).map((sp) =>
            i18n.t('run.confirm.finish.receiptIssueLine', {
              sku: ctx.skuName(sp.skuId),
              store: ctx.storeName(sp.storeId),
              received: formatQty(sp.confirmReceivedQty ?? '0'),
              qty: formatQty(sp.qty),
            }),
          ),
          more:
            issues.length > RECEIPT_ISSUES_LISTED
              ? i18n.t('run.confirm.finish.receiptIssuesMore', {
                  n: issues.length - RECEIPT_ISSUES_LISTED,
                })
              : null,
        }
      : null;
  return { rows, notes, stores, receipt };
}

/**
 * What closing a correction freezes again: the same money rows, from the
 * live (corrected) run.
 */
export function refinalizeConfirmSummary(ctx: ConfirmSummaryContext): ConfirmSummary {
  return { rows: moneyRows(ctx), notes: [], stores: [], receipt: null };
}
