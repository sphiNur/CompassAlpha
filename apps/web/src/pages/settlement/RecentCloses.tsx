/**
 * The store's last closes, each opening its day in the form. Review
 * CONF-06: moved out of SettlementPage. CONF-11: one card of rows
 * (UI-6); each close was a card of its own.
 */
import {
  Card,
  EmptyState,
  PendingState,
  QueryErrorBanner,
  SectionLabel,
  SectionRow,
  rowGroupClass,
} from '@compass/ui';
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
        <ul className={rowGroupClass} role="list">
          {recentQuery.data.map((record) => (
            <SectionRow
              key={record.id}
              label={dates.calendarDay(record.date)}
              hint={
                i18n.t('settlement.recent.version', { version: record.version }) +
                (record.updatedByName
                  ? ` · ${i18n.t('settlement.recent.updatedBy', { name: record.updatedByName })}`
                  : '')
              }
              onClick={() => onOpen(record.date)}
            />
          ))}
        </ul>
      ) : (
        <Card>
          <EmptyState compact title={i18n.t('settlement.recent.empty')} />
        </Card>
      )}
    </section>
  );
}
