/**
 * Admin → Attendance (2026-11-05): the manager's sheet, roster and
 * settings for one store. The store is the one picked in the store
 * switcher; on "all stores" the first store this person manages.
 */
import { useMemo, useState } from 'react';
import { EmptyState, Segmented, Select } from '@compass/ui';
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
  const preferred =
    storeCtx.kind === 'specific' && stores.some((st) => st.id === storeCtx.storeId)
      ? storeCtx.storeId
      : (stores[0]?.id ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const storeId = picked && stores.some((st) => st.id === picked) ? picked : preferred;
  const [view, setView] = useState<View>('sheet');
  const queue = trpc.attendance.reviewQueue.useQuery(
    { storeId: storeId ?? '' },
    { enabled: !!storeId, refetchInterval: 60_000 },
  );
  const toReview = (queue.data?.punches.length ?? 0) + (queue.data?.enrollments.length ?? 0);

  if (!storeId) {
    return (
      <div className="px-4 py-6">
        <EmptyState
          title={i18n.t('attendance.admin.noStoreTitle')}
          description={i18n.t('attendance.admin.noStoreBody')}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col pb-6">
      <div className="flex flex-col gap-3 px-4 pb-3">
        {stores.length > 1 ? (
          <Select
            value={storeId}
            onChange={(e) => setPicked(e.target.value)}
            aria-label={i18n.t('admin.field.stores')}
          >
            {stores.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Segmented<View>
          value={view}
          onChange={setView}
          ariaLabel={i18n.t('admin.section.attendance')}
          options={[
            { value: 'sheet', label: i18n.t('attendance.view.sheet') },
            {
              value: 'review',
              label:
                toReview > 0
                  ? `${i18n.t('attendance.view.review')} ${toReview}`
                  : i18n.t('attendance.view.review'),
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
