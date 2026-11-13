/**
 * Admin → Attendance (2026-11-05): the manager's sheet, roster and
 * settings for one store. A2 (2026-11-13): the store is the top bar's;
 * the page's own store select repeated it and did not follow it. On "all
 * stores" the page asks for one (unless this person manages only one),
 * and on a store they don't manage attendance for it says so.
 */
import { useMemo, useState } from 'react';
import { EmptyState, Segmented } from '@compass/ui';
import { StoreContextEmpty } from '../../components/NoStoreYet';
import { useStoreContext } from '../../hooks/useStoreContext';
import { useI18n } from '../../hooks/useI18n';
import { useAuthStore } from '../../stores/authStore';
import { AttendanceRoster, AttendanceSheet } from './AttendanceManage';
import { AttendanceExport } from './AttendanceExport';
import { AttendanceSettings } from './AttendanceSettings';
import { AttendanceReview } from './AttendanceReview';
import { trpc } from '../../lib/trpc';

type View = 'sheet' | 'review' | 'roster' | 'settings';

export function AttendanceAdmin() {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const storeCtx = useStoreContext();
  const stores = useMemo(
    () =>
      (session?.stores ?? []).filter((st) =>
        (session?.storePermissions?.[st.id] ?? session?.permissions ?? []).includes(
          'attendance.manage',
        ),
      ),
    [session],
  );
  const storeId =
    storeCtx.kind === 'specific'
      ? stores.some((st) => st.id === storeCtx.storeId)
        ? storeCtx.storeId
        : null
      : stores.length === 1
        ? (stores[0]?.id ?? null)
        : null;
  const [view, setView] = useState<View>('sheet');
  const queue = trpc.attendance.reviewQueue.useQuery(
    { storeId: storeId ?? '' },
    { enabled: !!storeId, refetchInterval: 60_000 },
  );
  const toReview = (queue.data?.punches.length ?? 0) + (queue.data?.enrollments.length ?? 0);

  if (!storeId) {
    if (stores.length > 0 && storeCtx.kind === 'all') return <StoreContextEmpty />;
    return (
      <div className="px-4 py-6">
        {stores.length > 0 ? (
          <EmptyState
            title={i18n.t('attendance.admin.otherStoreTitle')}
            description={i18n.t('attendance.admin.otherStoreBody')}
          />
        ) : (
          <EmptyState
            title={i18n.t('attendance.admin.noStoreTitle')}
            description={i18n.t('attendance.admin.noStoreBody')}
          />
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col pb-6">
      <div className="flex flex-col gap-3 px-4 pb-3">
        <Segmented<View>
          value={view}
          onChange={setView}
          ariaLabel={i18n.t('admin.section.attendance')}
          options={[
            { value: 'sheet', label: i18n.t('attendance.view.sheet') },
            {
              value: 'review',
              // Review ATT-16: the count stays whole beside the word. As one
              // string, four segments at 320 px in Russian or Uzbek cut the
              // number off first. The space keeps the two apart for a
              // screen reader.
              label:
                toReview > 0 ? (
                  <span className="flex min-w-0 items-center justify-center gap-1">
                    <span className="min-w-0 truncate">{i18n.t('attendance.view.review')}</span>{' '}
                    <span className="shrink-0 tabular-nums">{toReview}</span>
                  </span>
                ) : (
                  i18n.t('attendance.view.review')
                ),
            },
            { value: 'roster', label: i18n.t('attendance.view.roster') },
            { value: 'settings', label: i18n.t('attendance.view.settings') },
          ]}
        />
      </div>
      {view === 'sheet' ? (
        <>
          <AttendanceSheet key={storeId} storeId={storeId} />
          <AttendanceExport key={`export-${storeId}`} storeId={storeId} />
        </>
      ) : null}
      {view === 'review' ? <AttendanceReview key={storeId} storeId={storeId} /> : null}
      {view === 'roster' ? <AttendanceRoster key={storeId} storeId={storeId} /> : null}
      {view === 'settings' ? <AttendanceSettings key={storeId} storeId={storeId} /> : null}
    </div>
  );
}
