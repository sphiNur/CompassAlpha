/**
 * The close's summary card. Review CONF-06: moved out of SettlementPage;
 * the figures come from draftModel's settlementSummary.
 */
import { Card, CardBody, CardHeader, CardTitle } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { formatMoney } from '../../lib/format';
import type { SettlementSummaryLines } from './draftModel';
import {
  closeMetricCents,
  metricChange,
  numberToCents,
  type CompareMetric,
  type MetricChange,
} from './closeCompare';
import type { CloseComparison } from './useCloseComparison';

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

/**
 * UI overhaul E3: "vs yesterday +12% · vs same day last week −35%" under a
 * figure, the change marked when it is a third or more either way.
 */
function CompareLine({
  metric,
  current,
  compare,
  currency,
}: {
  metric: CompareMetric;
  current: number | null;
  compare: CloseComparison;
  currency: string;
}) {
  const i18n = useI18n();
  const now = numberToCents(current);
  const parts: { key: string; text: string; change: MetricChange }[] = [];
  const percent = new Intl.NumberFormat(i18n.locale, {
    style: 'percent',
    signDisplay: 'exceptZero',
    maximumFractionDigits: 0,
  });
  for (const [key, close] of [
    ['yesterday', compare.yesterday],
    ['lastWeek', compare.lastWeek],
  ] as const) {
    const change = close ? metricChange(now, closeMetricCents(close, metric)) : null;
    if (!change) continue;
    const amount =
      change.percent === null
        ? formatSignedMoney(Number(change.deltaCents) / 100, currency)
        : percent.format(change.percent / 100);
    parts.push({
      key,
      change,
      text: i18n.t(
        key === 'yesterday' ? 'settlement.compare.yesterday' : 'settlement.compare.lastWeek',
        {
          change: amount,
        },
      ),
    });
  }
  if (parts.length === 0) return null;
  const unusual = parts.some((part) => part.change.unusual);
  return (
    <p
      data-testid={`settlement-compare-${metric}`}
      data-unusual={unusual ? '' : undefined}
      className="-mt-0.5 pb-1 text-right text-old-label tabular-nums text-[var(--c-fg-muted)]"
    >
      {parts.map((part, index) => (
        <span key={part.key}>
          {index > 0 ? ' · ' : null}
          <span
            className={part.change.unusual ? 'font-semibold text-[var(--c-warn-ink)]' : undefined}
          >
            {part.text}
          </span>
        </span>
      ))}
      {unusual ? (
        <span className="sr-only">{` · ${i18n.t('settlement.compare.unusual')}`}</span>
      ) : null}
    </p>
  );
}

export function SettlementSummary({
  summary,
  currency,
  compare,
}: {
  summary: SettlementSummaryLines;
  currency: string;
  /** Yesterday's and last week's closes; absent while unknown. */
  compare?: CloseComparison;
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
        {compare ? (
          <CompareLine
            metric="totalRevenue"
            current={summary.totalRevenue}
            compare={compare}
            currency={currency}
          />
        ) : null}
        <SummaryRow
          label={i18n.t('settlement.summary.paidOutflows')}
          value={money(summary.paidOutflows)}
        />
        {compare ? (
          <CompareLine
            metric="paidOutflows"
            current={summary.paidOutflows}
            compare={compare}
            currency={currency}
          />
        ) : null}
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
