/**
 * CLS-20 (2026-10-30): every saved version of a day's close. Review
 * CONF-06: moved out of SettlementPage. CONF-11: the kit's Disclosure,
 * and the versions as one card of rows.
 */
import type { CatalogKey } from '@compass/i18n';
import { Disclosure, PendingState, QueryErrorBanner, rowGroupClass } from '@compass/ui';
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
  return (
    <Disclosure title={i18n.t('settlement.history.title')}>
      <RevisionList settlementId={settlementId} />
    </Disclosure>
  );
}

/** Mounted when the history is opened, which is when it loads. */
function RevisionList({ settlementId }: { settlementId: string }) {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const history = trpc.settlement.revisions.useQuery({ settlementId });
  if (history.isPending) return <PendingState query={history} />;
  if (history.isError) {
    return <QueryErrorBanner query={history} title={i18n.t('settlement.errors.load')} />;
  }
  return (
    <ul className={rowGroupClass} role="list">
      {history.data.map((rev) => (
        <li key={rev.version} className="px-4 py-2.5">
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
  );
}
