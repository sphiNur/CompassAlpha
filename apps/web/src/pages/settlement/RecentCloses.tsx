/**
 * The store's last closes, each opening its day in the form. Review
 * CONF-06: moved out of SettlementPage.
 */
import { Card, CardBody, PendingState, QueryErrorBanner, SectionLabel } from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { useDateFormat, useI18n } from '../../hooks/useI18n';

export function RecentCloses({
  storeId,
  onOpen,
}: {
  storeId: string;
  /** A close was tapped: show its day. */
  onOpen: (date: string) => void;
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const recentQuery = trpc.settlement.recent.useQuery({ storeId, limit: 7 });
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel as="h2">{i18n.t('settlement.recent.title')}</SectionLabel>
      {recentQuery.isPending ? (
        <PendingState query={recentQuery} />
      ) : recentQuery.isError && !recentQuery.data ? (
        // F11 (2026-10-30): a failed load read "no settlements yet".
        <QueryErrorBanner query={recentQuery} />
      ) : recentQuery.data?.length ? (
        <ul className="flex flex-col gap-2" role="list">
          {recentQuery.data.map((record) => (
            <li key={record.id}>
              <Card interactive>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  onClick={() => onOpen(record.date)}
                >
                  <span className="min-w-0">
                    <span className="block text-old-h3 font-semibold tabular-nums text-[var(--c-fg)]">
                      {dates.calendarDay(record.date)}
                    </span>
                    <span className="mt-0.5 block text-old-body-sm text-[var(--c-fg-muted)]">
                      {i18n.t('settlement.recent.version', { version: record.version })}
                      {record.updatedByName
                        ? ` · ${i18n.t('settlement.recent.updatedBy', { name: record.updatedByName })}`
                        : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-old-label font-semibold text-[var(--c-action)]">
                    {i18n.t('settlement.recent.open')}
                  </span>
                </button>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <Card>
          <CardBody>
            <p className="text-old-body-sm text-[var(--c-fg-muted)]">
              {i18n.t('settlement.recent.empty')}
            </p>
          </CardBody>
        </Card>
      )}
    </section>
  );
}
