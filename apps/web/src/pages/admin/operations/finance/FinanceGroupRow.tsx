/**
 * One group in Finance's day, stall or store view: a row with the group's
 * amount that opens its lines. Review ADM2-10 (2026-11-11): each view drew
 * its own copy, and only the day view had the 44 px row (R2-HIS-5); the
 * stall and store rows were about 34 px.
 */
import type { ReactNode } from 'react';
import { addMoney } from '@compass/contracts/money';
import { cn } from '@compass/ui';
import { useI18n } from '../../../../hooks/useI18n';
import { formatMoney } from '../../../../lib/format';
import type { FinanceGroup } from './financeGroups';

export function FinanceGroupRow({
  title,
  titleClassName,
  group,
  open,
  onToggle,
  children,
}: {
  title: ReactNode;
  titleClassName?: string;
  group: FinanceGroup<unknown>;
  open: boolean;
  onToggle: () => void;
  /** The group's lines, each an <li>; shown while it is open. */
  children: ReactNode;
}) {
  const i18n = useI18n();
  const mixed = group.cash > 0 && group.transfer > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left active:opacity-80"
      >
        <span className={cn('text-old-body font-semibold', titleClassName)}>{title}</span>
        <GroupAmount group={group} />
      </button>
      {mixed && group.unpriced === 0 ? (
        <div className="flex items-baseline gap-3 px-3 pb-1.5 text-old-label text-[var(--c-fg-muted)]">
          <span>
            {i18n.t('run.label.paymentCash')} {formatMoney(group.cash)}
          </span>
          <span>
            {i18n.t('run.label.paymentTransfer')} {formatMoney(group.transfer)}
          </span>
        </div>
      ) : null}
      {open ? (
        <ul className="flex flex-col border-t border-[var(--c-divider)]" role="list">
          {children}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A finance group's amount, or — when some of its lines carry no amount
 * (D6: no prices.view for their store) — how many lines it holds.
 */
function GroupAmount({ group }: { group: FinanceGroup<unknown> }) {
  const i18n = useI18n();
  return group.unpriced === 0 ? (
    <span className="text-old-body tabular-nums">
      {formatMoney(addMoney(group.cash, group.transfer))}
    </span>
  ) : (
    <span className="text-old-label text-[var(--c-fg-muted)]">
      {i18n.t('finance.count.lines', { n: group.lines.length })}
    </span>
  );
}
