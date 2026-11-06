/**
 * Clock-in photos are kept 90 days (2026-11-05): long enough to settle a
 * month's pay and any dispute, no longer. Run with the reminder scan.
 */
import { sql } from 'drizzle-orm';
import { inSystem, type DB } from '@compass/db';

export const PHOTO_RETENTION_DAYS = 90;

export async function purgeOldAttendancePhotos(db: DB, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PHOTO_RETENTION_DAYS * 24 * 3600_000).toISOString();
  const rows = await inSystem(db, 'maintenance', (tx) =>
    tx.execute(sql`
      DELETE FROM inventory.attendance_photos
       WHERE id IN (SELECT id FROM inventory.attendance_photos
                     WHERE taken_at < ${cutoff}::timestamptz LIMIT 5000)
      RETURNING id`),
  );
  return (rows as unknown as unknown[]).length;
}
