/**
 * The figures of the finish and correction confirmations, shown above
 * their text (review RUNWEB1-08): the run's money as rows, each figure
 * once, then notes on the prices, each store's bill and what the stores
 * signed for short. What it says comes from runs/lib/confirmSummary.ts;
 * this only lays it out, with the kit's rows.
 */
import { Banner, Card, DetailRow, SectionLabel } from '@compass/ui';
import { useI18n } from '../../../hooks/useI18n';
import type { ConfirmSummary } from '../lib/confirmSummary';

/**
 * Figures line up (UI-14) and keep their width: DetailRow lets the label
 * and the value shrink alike, so a long label (ru, uz) cut the amount
 * short on a 320 px phone. The label wraps beside it instead.
 */
const FIGURE_ROW = 'tabular-nums [&>span:last-child]:shrink-0';

export function RunConfirmSummary({ summary }: { summary: ConfirmSummary }) {
  const i18n = useI18n();
  return (
    <>
      <Card data-testid="run-confirm-summary" className="flex flex-col gap-2 px-4 py-3">
        {summary.rows.map((row) => (
          <DetailRow
            key={row.key}
            className={FIGURE_ROW}
            label={row.label}
            value={
              row.key === 'total' ? <span className="font-semibold">{row.value}</span> : row.value
            }
          />
        ))}
      </Card>
      {summary.notes.length > 0 ? (
        <Banner tone="info">
          {summary.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </Banner>
      ) : null}
      {summary.stores.length > 0 ? (
        <section>
          <SectionLabel as="h3" padded={false} className="mb-2">
            {i18n.t('run.history.storesHeading')}
          </SectionLabel>
          <Card className="flex flex-col gap-2 px-4 py-3">
            {summary.stores.map((store) => (
              <DetailRow
                key={store.storeId}
                className={FIGURE_ROW}
                label={
                  <>
                    <span className="block break-words font-semibold text-[var(--c-fg)]">
                      {store.name}
                    </span>
                    {store.paidBoth ? <span className="block">{store.paidBoth}</span> : null}
                  </>
                }
                value={store.total}
              />
            ))}
          </Card>
        </section>
      ) : null}
      {summary.receipt ? (
        <Banner tone="warn">
          <p>{summary.receipt.summary}</p>
          <ul>
            {summary.receipt.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {summary.receipt.more ? <p>{summary.receipt.more}</p> : null}
        </Banner>
      ) : null}
    </>
  );
}
