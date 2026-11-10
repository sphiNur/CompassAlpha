import { closeDb, getDb, type DB } from '@compass/db';

/**
 * Runs one command's work on the database as `maintenance` (every query
 * crosses tenants), then closes the connection: after the work is done,
 * after a refusal and after a failure. Each command used to open and close
 * it on its own.
 */
export async function withMaintenanceDb<T>(work: (db: DB) => Promise<T>): Promise<T> {
  const db = getDb(undefined, { system: 'maintenance' });
  try {
    return await work(db);
  } finally {
    await closeDb();
  }
}
