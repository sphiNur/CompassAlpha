/**
 * Bot reminders for work that is waiting (UI overhaul E2, owner 2026-11-15):
 *   - orders submitted an hour ago or more that no one has picked up
 *     for review → the store's reviewers (`order.approve` there), once per
 *     oldest waiting order;
 *   - no daily close for today by 22:00 store time → whoever records the
 *     store's close (`settlement.record` there), once per store and day.
 *     Only stores that filed a close in the 7 days before, so a store that
 *     does not do daily closes is never nagged.
 * Scanned every few minutes by the API process; `dispatch` dedups, so a
 * repeated scan (or two API processes) sends each reminder once.
 */
import { sql } from 'drizzle-orm';
import { inSystem, type DB } from '@compass/db';
import { dateInTz } from '@compass/domain';
import { storeTimeZone } from './timeZone';
import { dispatch, findRecipientsByPermissionInStore } from './notify';
import { linkForStore } from './notifyForEvent';

/** An order waits this long for review before its store is reminded. */
export const PENDING_REVIEW_MINUTES = 60;
/** Orders submitted longer ago than this are left alone (old backlog). */
const PENDING_REVIEW_MAX_HOURS = 24;
/** Store-local hour from which a missing daily close is reminded. */
export const CLOSE_REMINDER_HOUR = 22;
/** A store counts as doing daily closes when it filed one in these days. */
const CLOSE_ACTIVE_DAYS = 7;

const DAY = 86_400_000;

/** The hour (0–23) of `at` on the wall clock of `tz`. */
export function hourInTz(at: Date, tz: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  return Number(hour);
}

type PendingRow = {
  org_id: string;
  store_id: string;
  store_name: string;
  oldest_id: string;
  waiting: number;
};

/** Remind reviewers of orders waiting since PENDING_REVIEW_MINUTES; returns stores reminded. */
export async function scanPendingReviewReminders(
  db: DB,
  now: Date = new Date(),
  options: { onError?: (storeId: string, err: unknown) => void } = {},
): Promise<number> {
  const nowIso = now.toISOString();
  const rows = await inSystem(db, 'worker', (tx) =>
    tx.execute<PendingRow>(sql`
      SELECT os.org_id, os.store_id, st.name AS store_name,
             (array_agg(os.id ORDER BY os.submitted_at, os.id))[1] AS oldest_id,
             count(*)::int AS waiting
        FROM read_model.order_sessions_v os
        JOIN inventory.stores st ON st.id = os.store_id AND st.deleted_at IS NULL AND st.is_active
       WHERE os.status = 'submitted'
         AND os.claimed_by_member_id IS NULL
         AND os.submitted_at <= ${nowIso}::timestamptz - make_interval(mins => ${PENDING_REVIEW_MINUTES})
         AND os.submitted_at > ${nowIso}::timestamptz - make_interval(hours => ${PENDING_REVIEW_MAX_HOURS})
       GROUP BY os.org_id, os.store_id, st.name
    `),
  );
  let sent = 0;
  for (const r of rows as unknown as PendingRow[]) {
    try {
      await inSystem(db, 'worker', async (tx) => {
        const reviewers = await findRecipientsByPermissionInStore(
          tx,
          r.org_id,
          'order.approve',
          r.store_id,
        );
        await dispatch(tx, r.org_id, reviewers, {
          template: 'order.reviewWaiting',
          title: 'Orders waiting for review',
          vars: { store: r.store_name, n: Number(r.waiting) },
          deepLink: linkForStore('/approve', r.store_id),
          // Once per oldest waiting order: when it is reviewed, the next
          // one reminds again only after it too has waited the hour.
          dedupKey: `order:${r.oldest_id}:reviewWaiting`,
          payload: { storeId: r.store_id },
        });
      });
      sent++;
    } catch (err) {
      options.onError?.(r.store_id, err);
    }
  }
  return sent;
}

type StoreRow = {
  org_id: string;
  store_id: string;
  store_name: string;
  store_tz: string | null;
  org_tz: string;
};

/** Remind the close's recorders of a store with no close today by CLOSE_REMINDER_HOUR. */
export async function scanMissingCloseReminders(
  db: DB,
  now: Date = new Date(),
  options: { onError?: (storeId: string, err: unknown) => void } = {},
): Promise<number> {
  const nowIso = now.toISOString();
  // A first cut in SQL (filed in the last 8 days by any calendar); the
  // store's own day is worked out below, in its time zone.
  const rows = await inSystem(db, 'worker', (tx) =>
    tx.execute<StoreRow>(sql`
      SELECT st.org_id, st.id AS store_id, st.name AS store_name,
             st.timezone AS store_tz, o.timezone AS org_tz
        FROM inventory.stores st
        JOIN auth.organizations o ON o.id = st.org_id
       WHERE st.deleted_at IS NULL AND st.is_active
         AND EXISTS (
           SELECT 1 FROM inventory.store_daily_settlements d
            WHERE d.store_id = st.id
              AND d.settlement_date >= (${nowIso}::timestamptz - make_interval(days => ${CLOSE_ACTIVE_DAYS + 1}))::date)
    `),
  );
  let sent = 0;
  for (const r of rows as unknown as StoreRow[]) {
    try {
      const tz = storeTimeZone(r.store_tz, r.org_tz);
      if (hourInTz(now, tz) < CLOSE_REMINDER_HOUR) continue;
      const today = dateInTz(now, tz);
      const firstActiveDay = dateInTz(new Date(now.getTime() - CLOSE_ACTIVE_DAYS * DAY), tz);
      const done = await inSystem(db, 'worker', async (tx) => {
        const filed = await tx.execute<{ today: boolean; recent: boolean }>(sql`
          SELECT bool_or(settlement_date = ${today}::date) AS today,
                 bool_or(settlement_date >= ${firstActiveDay}::date
                         AND settlement_date < ${today}::date) AS recent
            FROM inventory.store_daily_settlements
           WHERE store_id = ${r.store_id}::uuid AND org_id = ${r.org_id}::uuid
        `);
        const row = (filed as unknown as { today: boolean | null; recent: boolean | null }[])[0];
        if (row?.today || !row?.recent) return false;
        const recorders = await findRecipientsByPermissionInStore(
          tx,
          r.org_id,
          'settlement.record',
          r.store_id,
        );
        await dispatch(tx, r.org_id, recorders, {
          template: 'settlement.closeMissing',
          title: 'Daily close not recorded',
          vars: { store: r.store_name },
          deepLink: linkForStore('/settlement', r.store_id),
          dedupKey: `settlement:${r.store_id}:${today}:closeMissing`,
          payload: { storeId: r.store_id, date: today },
        });
        return true;
      });
      if (done) sent++;
    } catch (err) {
      options.onError?.(r.store_id, err);
    }
  }
  return sent;
}
