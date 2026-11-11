/**
 * CLS-20 (2026-10-30): every saved version of a day's close. Review
 * CONF-06: moved out of SettlementPage.
 */
import { useState } from 'react';
import type { CatalogKey } from '@compass/i18n';
import { Banner, LoadingState } from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { useDateFormat, useI18n } from '../../hooks/useI18n';

const HISTORY_FIELD_KEY: Record<string, CatalogKey> = {
  onlineRevenue: 'settlement.field.onlineRevenue',
  invoicedCashRevenue: 'settlement.field.invoicedCashRevenue',
  operatingExpenses: 'settlement.field.operatingExpenses',
  wagesPaid: 'settlement.field.wagesPaid',
  wagesAccrued: 'settlement.field.wagesAccrued',
  nextPurchaseReserve: 'settlement.field.nextPurchaseReserve',
  priorPurchaseAdjustment: 'settlement.field.priorPurchaseAdjustment',
  cashOnHand: 'settlement.field.cashOnHand',
  note: 'settlement.field.note',
  operatingExpenseItems: 'settlement.expenses.title',
  wageItems: 'settlement.wages.title',
};

/**
 * CLS-20 (2026-10-30): every saved version of this day — who, when, what
 * changed, and why. The page only said "version N · updated by X".
 */
export function SettlementHistory({ settlementId }: { settlementId: string }) {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const [open, setOpen] = useState(false);
  const history = trpc.settlement.revisions.useQuery({ settlementId }, { enabled: open });
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2.5 text-left text-old-body font-semibold text-[var(--c-fg)] ring-hairline"
      >
        {i18n.t('settlement.history.title')}
        <span aria-hidden className={'transition-transform ' + (open ? 'rotate-90' : '')}>
          ›
        </span>
      </button>
      {open ? (
        history.isPending ? (
          <LoadingState variant="compact" />
        ) : history.isError ? (
          <Banner tone="danger" title={i18n.t('settlement.errors.load')} />
        ) : (
          <ul className="flex flex-col gap-2" role="list">
            {(history.data ?? []).map((rev) => (
              <li
                key={rev.version}
                className="rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-2.5 ring-hairline"
              >
                <div className="text-old-body-sm font-semibold text-[var(--c-fg)]">
                  {i18n.t('settlement.recent.version', { version: rev.version })} ·{' '}
                  {dateFmt.dateTime(rev.createdAt)}
                  {rev.actorName ? ` · ${rev.actorName}` : ''}
                </div>
                {rev.version === 1 ? (
                  <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('settlement.history.created')}
                  </div>
                ) : rev.changedFields.length > 0 ? (
                  <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('settlement.history.changed', {
                      fields: rev.changedFields
                        .map((f) => {
                          const key = HISTORY_FIELD_KEY[f];
                          return key ? i18n.t(key) : f;
                        })
                        .join(i18n.t('common.listSeparator')),
                    })}
                  </div>
                ) : null}
                {rev.correctionReason ? (
                  <div className="mt-0.5 whitespace-pre-wrap text-old-label text-[var(--c-fg)]">
                    {i18n.t('settlement.history.reason', { reason: rev.correctionReason })}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
