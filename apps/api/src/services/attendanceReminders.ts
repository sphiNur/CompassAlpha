/**
 * Attendance reminders over the bot (2026-11-05), scanned every few
 * minutes by the API process:
 *   - a member switched on for clocking who has not clocked in after the
 *     grace minutes of a planned shift → remind them;
 *   - still nothing 30 minutes in → tell the store's managers;
 *   - clocked in but not out 30 minutes after the shift → remind them.
 * The rule is `attendance.dueReminders`; `dispatch` dedups per shift, so
 * a repeated scan (or two API processes) sends each reminder once.
 */
import { sql } from 'drizzle-orm';
import { inSystem, type DB } from '@compass/db';
import { attendance as rules } from '@compass/domain';
import { storeTimeZone } from './timeZone';
import { dispatch, findRecipientsByPermissionInStore } from './notify';
import { linkForStore } from './notifyForEvent';

type Row = {
  shift_id: string;
  org_id: string;
  store_id: string;
  store_name: string;
  store_tz: string | null;
  org_tz: string;
  user_id: string;
  member_name: string;
  starts_at: Date | string;
  ends_at: Date | string;
  grace_minutes: number;
  last_kind: 'in' | 'out' | null;
};

const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

export async function scanAttendanceReminders(
  db: DB,
  now: Date = new Date(),
  options: {
    /**
     * COREAPI-13 (2026-11-09): a shift whose reminder fails is reported
     * here and the scan goes on; one bad row used to end the scan for
     * every organisation.
     */
    onShiftError?: (shiftId: string, err: unknown) => void;
  } = {},
): Promise<number> {
  // Raw queries take the instant as text (postgres-js rejects a Date here).
  const nowIso = now.toISOString();
  const rows = await inSystem(db, 'worker', (tx) =>
    tx.execute<Row>(sql`
      SELECT sh.id AS shift_id, sh.org_id, sh.store_id, st.name AS store_name,
             st.timezone AS store_tz, o.timezone AS org_tz, m.user_id,
             u.display_name AS member_name, sh.starts_at, sh.ends_at,
             coalesce(p.grace_minutes, 5) AS grace_minutes,
             (SELECT ap.kind FROM inventory.attendance_punches ap
               WHERE ap.member_id = sh.member_id AND ap.store_id = sh.store_id
                 AND ap.voided_at IS NULL
                 AND ap.punched_at >= sh.starts_at - interval '4 hours'
                 AND ap.punched_at <= ${nowIso}::timestamptz
               ORDER BY ap.punched_at DESC LIMIT 1) AS last_kind
        FROM inventory.attendance_shifts sh
        JOIN auth.members m ON m.id = sh.member_id AND m.status = 'active'
        JOIN auth.users u ON u.id = m.user_id AND u.deleted_at IS NULL
        JOIN auth.organizations o ON o.id = sh.org_id
        JOIN inventory.stores st ON st.id = sh.store_id AND st.deleted_at IS NULL AND st.is_active
        LEFT JOIN inventory.attendance_store_policies p ON p.store_id = sh.store_id
       WHERE (sh.starts_at BETWEEN ${nowIso}::timestamptz - interval '3 hours' AND ${nowIso}::timestamptz
              OR sh.ends_at BETWEEN ${nowIso}::timestamptz - interval '6 hours' AND ${nowIso}::timestamptz)
         AND EXISTS (
           SELECT 1 FROM auth.member_permission_overrides o2
            WHERE o2.member_id = sh.member_id AND o2.permission_key = 'attendance.clock'
              AND o2.effect = 'allow' AND o2.scope_type = 'global'
              AND (o2.expires_at IS NULL OR o2.expires_at > ${nowIso}::timestamptz))
    `),
  );
  let sent = 0;
  for (const r of rows as unknown as Row[]) {
    try {
      sent += await remindShift(db, r, now);
    } catch (err) {
      options.onShiftError?.(r.shift_id, err);
    }
  }
  return sent;
}

/** Send one shift's due reminders; returns how many went out. */
async function remindShift(db: DB, r: Row, now: Date): Promise<number> {
  const startsAt = asDate(r.starts_at);
  const endsAt = asDate(r.ends_at);
  const due = rules.dueReminders({
    startsAt,
    endsAt,
    graceMinutes: Number(r.grace_minutes),
    lastKind: r.last_kind,
    now,
  });
  if (due.length === 0) return 0;
  const tz = storeTimeZone(r.store_tz, r.org_tz);
  const vars = {
    store: r.store_name,
    name: r.member_name,
    start: rules.localTime(startsAt, tz),
    end: rules.localTime(endsAt, tz),
  };
  return inSystem(db, 'worker', async (tx) => {
    let sent = 0;
    for (const action of due) {
      if (action === 'remindIn' || action === 'remindOut') {
        const clockIn = action === 'remindIn';
        await dispatch(tx, r.org_id, [r.user_id], {
          // Spelled out, so the unused-key scan can match them to their notify.* texts.
          template: clockIn ? 'attendance.remindIn' : 'attendance.remindOut',
          title: clockIn ? 'Time to clock in' : 'Did you clock out?',
          vars,
          deepLink: linkForStore('/attendance', r.store_id),
          dedupKey: `attendance:${r.shift_id}:${action}`,
        });
      } else {
        const managers = await findRecipientsByPermissionInStore(
          tx,
          r.org_id,
          'attendance.manage',
          r.store_id,
        );
        await dispatch(tx, r.org_id, managers, {
          template: 'attendance.absent',
          title: 'Not clocked in',
          vars,
          deepLink: linkForStore('/admin', r.store_id),
          dedupKey: `attendance:${r.shift_id}:absent`,
        });
      }
      sent++;
    }
    return sent;
  });
}
