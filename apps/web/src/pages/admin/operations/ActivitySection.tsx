/**
 * Admin → Operations → Live activity: key figures, then the latest order
 * and run events (with the debug page embedded for super admins).
 * Review ADM2-10 (2026-11-11): one file per Operations section; they
 * shared one 2,260-line file.
 */
import { useState } from 'react';
import { isCatalogKey } from '@compass/i18n';
import { DataState, EmptyState, SectionLabel, Tile, cn, rowGroupClass } from '@compass/ui';
import { PAGE_SIZE } from '../../../config/timings';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { formatQty } from '../../../lib/format';
import { useDateFormat, useI18n, useProductName, useUnitLabel } from '../../../hooks/useI18n';
import { DebugPage } from '../../DebugPage';
import { activityDetail } from './activityDetail';

export function ActivitySection() {
  const dateFmt = useDateFormat();
  const i18n = useI18n();
  const productName = useProductName();
  const unitLabel = useUnitLabel();
  const eventLabel = (streamType: string, type: string): string => {
    const key = `ops.event.${type}`;
    return isCatalogKey(key) ? i18n.t(key) : `${streamType}.${type}`;
  };
  const overview = trpc.admin.overview.useQuery();
  const eventsQuery = trpc.admin.recentEvents.useQuery({ limit: PAGE_SIZE.feed });
  const [showDebug, setShowDebug] = useState(false);
  // M1.9 (2026-05-07): the embedded debug console (348 lines of dev
  // tooling: live/server/health log streams, ring buffers, raw JSON)
  // does not belong in the chain owner's day-1 admin view. Gate to
  // super_admin so it stays reachable for the dev account but the
  // owner doesn't accidentally collapse-expand it and leave 2s polls
  // running in the background.
  const session = useAuthStore((s) => s.session);
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;

  return (
    <div className="px-4 py-3">
      <DataState query={overview}>
        {(d) => (
          <div className="grid grid-cols-2 gap-3">
            <Tile label={i18n.t('admin.tile.members')} value={d.memberCount} />
            <Tile label={i18n.t('admin.tile.stores')} value={d.storeCount} />
            <Tile label={i18n.t('admin.tile.activeSkus')} value={d.skuCount} />
            <Tile label={i18n.t('admin.tile.totalRuns')} value={d.runCount} />
            <Tile
              label={i18n.t('admin.tile.pendingApprovals')}
              value={d.pendingApprovals}
              accent={d.pendingApprovals > 0 ? 'warn' : 'muted'}
            />
            <Tile label={i18n.t('admin.tile.ordersThisWeek')} value={d.ordersThisWeek} />
          </div>
        )}
      </DataState>

      <SectionLabel as="h2" padded={false} className="mt-6 mb-2">
        {i18n.t('ops.activity.recentEvents')}
      </SectionLabel>
      <DataState
        query={eventsQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('ops.activity.emptyTitle')}
            description={i18n.t('ops.activity.emptyBody')}
          />
        }
      >
        {(rows) => (
          <ul className={rowGroupClass} role="list">
            {rows.map((e) => {
              // M3.21 (2026-05-18): surface ClaimReleased.reason inline
              // so admins can spot non-routine releases (override / timeout)
              // at a glance. Override = somebody took over another
              // approver's claim; timeout = the worker swept an idle
              // claim. Both warrant a heads-up tint; manual / pagehide
              // are routine, no decoration.
              const claimReason =
                e.type === 'ClaimReleased'
                  ? (e.payload as { reason?: string } | null)?.reason
                  : undefined;
              const isIntervention = claimReason === 'override' || claimReason === 'timeout';
              const rowBg = isIntervention ? 'bg-[var(--c-warn-bg)]' : '';
              // DX-CAT-2 (2026-11-01): which product, store and order or
              // run — in place of "seq N". Older servers send no context.
              const detail = activityDetail(e.context, {
                productName: (names) => productName({ names }),
                qty: (v, unit) => (unit ? `${formatQty(v)} ${unitLabel(unit, v)}` : formatQty(v)),
                day: (d) => dateFmt.calendarDay(d),
                orderOf: (date) => i18n.t('ops.activity.orderOf', { date }),
                runLabel: (date, n) => i18n.t('ops.purge.runLabel', { date, n }),
              });
              // The reason a claim went back, in words; the routine ones
              // (released by hand, page closed) need none.
              const claimNote =
                claimReason === 'override'
                  ? i18n.t('ops.activity.claimOverride')
                  : claimReason === 'timeout'
                    ? i18n.t('ops.activity.claimTimeout')
                    : null;
              return (
                <li key={e.id} className={cn('flex flex-col gap-0.5 px-4 py-2.5', rowBg)}>
                  <span className="text-old-label font-semibold text-[var(--c-fg)]">
                    {/* ADM-17: the event in words, from the catalog;
                        an event type it does not know yet stays raw. */}
                    {eventLabel(e.streamType, e.type)}
                  </span>
                  {detail ? (
                    <span className="text-old-label text-[var(--c-fg)]">{detail}</span>
                  ) : null}
                  {claimNote ? (
                    <span className="text-old-label text-[var(--c-warn-ink)]">{claimNote}</span>
                  ) : null}
                  <div className="flex items-baseline justify-between gap-2 text-old-label text-[var(--c-fg-muted)]">
                    <span className="truncate">
                      {e.actor?.displayName ?? i18n.t('ops.activity.system')}
                      {e.actor?.tgUsername ? ` · @${e.actor.tgUsername}` : ''}
                    </span>
                    <span className="text-old-label tabular-nums">
                      {/* 2026-07-30: `[]` meant "browser locale". */}
                      {dateFmt.dateTime(e.occurredAt)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      {isSuperAdmin ? (
        <>
          {/* Review ADM2-32 (2026-11-11): says whether it is open; the
              arrow is only a picture. */}
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            aria-expanded={showDebug}
            className="press mt-6 inline-flex min-h-11 items-center gap-1 text-old-label text-[var(--c-fg-muted)]"
          >
            <span aria-hidden="true">{showDebug ? '▾' : '▸'}</span> {i18n.t('ops.debug.toggle')}
          </button>
          {showDebug ? (
            <div className="-mx-4 mt-2 border-t border-[var(--c-divider)]">
              <DebugPage />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
