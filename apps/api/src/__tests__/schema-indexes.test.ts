/**
 * Review DB-12 (2026-11-12): the Drizzle schema is where a reader learns
 * the database's rules, and several unique and partial indexes lived only
 * in the SQL migrations (one pending face enrolment per person, one punch
 * per liveness challenge). Every index the migrations make, primary keys
 * aside, is now declared in the schema under the same name, and every
 * index the schema declares exists. The comparison is by name: what an
 * index covers is still for the reader to keep in step.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/schema-indexes.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getDb, schema } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';

/** Made with what the schema's builder cannot say; see the comments at their tables. */
const SQL_ONLY = ['auth.mpo_unique', 'auth.mrb_binding_unique'];

/** The schema's tables' Postgres schemas, and the indexes it declares, as `schema.name`. */
function declared(): { schemas: string[]; indexes: string[] } {
  const schemas = new Set<string>();
  const indexes: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const pgSchema = config.schema ?? 'public';
    schemas.add(pgSchema);
    const names = [
      ...config.indexes.map((i) => i.config.name),
      ...config.uniqueConstraints.map((u) => u.getName()),
      ...config.columns.filter((c) => c.isUnique).map((c) => c.uniqueName),
    ];
    for (const name of names) if (name) indexes.push(`${pgSchema}.${name}`);
  }
  return { schemas: [...schemas], indexes: indexes.sort() };
}

describe.skipIf(!SHOULD_RUN)('the schema and the migrated database (PG-gated)', () => {
  test('declare the same indexes', async () => {
    const { schemas, indexes } = declared();
    const rows = (await getDb(undefined, { system: 'maintenance' }).execute(sql`
      SELECT n.nspname || '.' || c.relname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisprimary
        AND n.nspname IN (${sql.join(
          schemas.map((name) => sql`${name}`),
          sql`, `,
        )})
    `)) as unknown as Array<{ name: string }>;
    const migrated = rows
      .map((row) => row.name)
      .filter((name) => !SQL_ONLY.includes(name))
      .sort();
    expect(migrated).toEqual(indexes);
  });
});
