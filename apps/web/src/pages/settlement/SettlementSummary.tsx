/**
 * The close's summary card. Review CONF-06: moved out of SettlementPage;
 * the figures come from draftModel's settlementSummary.
 */
import { Card, CardBody, CardHeader, CardTitle } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { formatMoney } from '../../lib/format';
import type { SettlementSummaryLines } from './draftModel';

/** DX-CLS-4: `null` while a field it adds up is invalid — shown as "—". */
function SummaryRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-old-body-sm">
      <span className="text-[var(--c-fg-muted)]">{label}</span>
      <strong className="shrink-0 tabular-nums text-[var(--c-fg)]">{value ?? '—'}</strong>
    </div>
  );
}

function formatSignedMoney(value: number, currency: string): string {
  const formatted = formatMoney(Math.abs(value), currency);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

export function SettlementSummary({
  summary,
  currency,
}: {
  summary: SettlementSummaryLines;
  currency: string;
}) {
  const i18n = useI18n();
  const money = (value: number | null) => (value === null ? null : formatMoney(value, currency));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{i18n.t('settlement.summary.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <SummaryRow
          label={i18n.t('settlement.summary.totalRevenue')}
          value={money(summary.totalRevenue)}
        />
        <SummaryRow
          label={i18n.t('settlement.summary.paidOutflows')}
          value={money(summary.paidOutflows)}
        />
        <SummaryRow
          label={i18n.t('settlement.summary.futureCommitments')}
          value={money(summary.futureCommitments)}
        />
        <SummaryRow
          label={i18n.t('settlement.summary.priorPurchaseAdjustment')}
          value={
            summary.priorPurchaseAdjustment === null
              ? null
              : formatSignedMoney(summary.priorPurchaseAdjustment, currency)
          }
        />
        <SummaryRow
          label={i18n.t('settlement.summary.endingCash')}
          value={money(summary.endingCash)}
        />
      </CardBody>
    </Card>
  );
}
