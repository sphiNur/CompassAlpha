/**
 * The money at the top of a history sheet: the total, its items and
 * expenses parts, and what went in cash and by transfer.
 *
 * Review RUNWEB2-09 (2026-11-12): the day sheet and the run detail each
 * wrote this panel out, and their rules had drifted apart: the run detail
 * hid the cash / transfer row when nothing was paid, the day sheet said
 * "Cash 0 · Transfer 0". One panel, one rule.
 */
import type { ReactNode } from 'react';
import { toCents } from '@compass/contracts/money';
import { SectionLabel, surfaceClass } from '@compass/ui';
import { useI18n } from '../../../hooks/useI18n';
import { useCurrency } from '../../../hooks/useCurrency';
import { formatMoney } from '../../../lib/format';

type Amount = string | number;

export function MoneySummaryPanel({
  total,
  itemsTotal,
  expensesTotal,
  cash,
  transfer,
  aside,
  children,
}: {
  total: Amount;
  itemsTotal: Amount;
  expensesTotal: Amount;
  /** Null when the money predates the cash / transfer split. */
  cash: Amount | null;
  transfer: Amount | null;
  /** Beside the total, on the right (the run's counts). */
  aside?: ReactNode;
  /** Between the total and the payment row (the receiving problems). */
  children?: ReactNode;
}) {
  const i18n = useI18n();
  const currency = useCurrency();
  return (
    <div className={`flex flex-col gap-2 px-4 py-3 ${surfaceClass}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <SectionLabel padded={false}>{i18n.t('run.history.totalLabel')}</SectionLabel>
          {/* M2.2: headline money unified to text-old-h2 (17 px) across
              pages. Was text-old-h1 (22 px) — only Order's estimate and
              Admin's sales tiles use text-old-h2 for the same role, so the
              history headline felt oversized by comparison. */}
          <div className="text-old-h2 font-semibold tabular-nums">
            {formatMoney(total)} {currency}
          </div>
          {/* 2026-10-21 CA-11: total = items + expenses, shown as its parts
              whenever expenses are part of it. */}
          {toCents(expensesTotal) > 0n ? (
            <div className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
              {i18n.t('run.money.itemsExpenses', {
                items: formatMoney(itemsTotal),
                expenses: formatMoney(expensesTotal),
              })}
            </div>
          ) : null}
        </div>
        {aside}
      </div>
      {children}
      {/* M1.14: payment-method breakdown row. 2026-10-23: shown whenever
          there is money, not only when both methods were used — a
          one-store, all-cash day still needs to say how much was cash and
          that transfer was 0. */}
      {cash !== null && transfer !== null && toCents(cash) + toCents(transfer) > 0n ? (
        <div className="flex items-baseline gap-3 border-t border-[var(--c-divider)] pt-2 text-old-label">
          <span className="text-[var(--c-fg-muted)]">{i18n.t('run.label.paymentCash')}</span>
          <span className="tabular-nums text-[var(--c-fg)]">{formatMoney(cash)}</span>
          <span className="ml-auto text-[var(--c-fg-muted)]">
            {i18n.t('run.label.paymentTransfer')}
          </span>
          <span className="tabular-nums text-[var(--c-fg)]">{formatMoney(transfer)}</span>
        </div>
      ) : null}
    </div>
  );
}
