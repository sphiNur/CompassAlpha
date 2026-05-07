import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

let _client: ReturnType<typeof postgres> | null = null;
let _db: DB | null = null;

export function getDb(url?: string): DB {
  if (_db) return _db;
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');
  _client = postgres(connectionString, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  _db = drizzle(_client, { schema, logger: process.env.DB_DEBUG === '1' });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
  }
}

export { schema };
