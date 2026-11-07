/**
 * Clock-in photos are kept 90 days (2026-11-05): long enough to settle a
 * month's pay and any dispute, no longer. The frame prints that refuse a
 * picture sent twice (2026-11-07) are kept as long. Run with the reminder
 * scan.
 */
import { sql } from 'drizzle-orm';
import { inSystem, type DB } from '@compass/db';

export const PHOTO_RETENTION_DAYS = 90;

const cutoffOf = (now: Date) =>
  new Date(now.getTime() - PHOTO_RETENTION_DAYS * 24 * 3600_000).toISOString();

export async function purgeOldAttendancePhotos(db: DB, now: Date = new Date()): Promise<number> {
  const cutoff = cutoffOf(now);
  const rows = await inSystem(db, 'maintenance', (tx) =>
    tx.execute(sql`
      DELETE FROM inventory.attendance_photos
       WHERE id IN (SELECT id FROM inventory.attendance_photos
                     WHERE taken_at < ${cutoff}::timestamptz LIMIT 5000)
      RETURNING id`),
  );
  return (rows as unknown as unknown[]).length;
}

/** The frame prints (a hash and face numbers per frame) past 90 days. */
export async function purgeOldFramePrints(db: DB, now: Date = new Date()): Promise<number> {
  const cutoff = cutoffOf(now);
  const rows = await inSystem(db, 'maintenance', (tx) =>
    tx.execute(sql`
      DELETE FROM inventory.attendance_punch_frames
       WHERE id IN (SELECT id FROM inventory.attendance_punch_frames
                     WHERE taken_at < ${cutoff}::timestamptz LIMIT 5000)
      RETURNING id`),
  );
  return (rows as unknown as unknown[]).length;
}
