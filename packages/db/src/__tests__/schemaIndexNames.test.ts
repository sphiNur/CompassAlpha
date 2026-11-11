/**
 * Review DB-10 (2026-11-11): index names are unique within a Postgres
 * schema, and Drizzle's `index('name')` does not check that. Two tables of
 * inventory declared `apr_org_idx`; the migration that created the second
 * found the name taken and skipped it without an error.
 *
 * Unique constraints count too: Postgres builds an index under the
 * constraint's name.
 */
import { describe, expect, test } from 'bun:test';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema';

describe('the Drizzle schema', () => {
  test('no two tables of one Postgres schema declare the same index name', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      const pgSchema = config.schema ?? 'public';
      const table = `${pgSchema}.${config.name}`;
      const names = [
        ...config.indexes.map((i) => i.config.name),
        ...config.uniqueConstraints.map((u) => u.getName()),
      ];
      for (const name of names) {
        if (!name) continue;
        const key = `${pgSchema}.${name}`;
        const other = owner.get(key);
        if (other !== undefined && other !== table) clashes.push(`${key}: ${other} and ${table}`);
        owner.set(key, table);
      }
    }
    expect(clashes).toEqual([]);
    // The schema was read at all.
    expect(owner.size).toBeGreaterThan(100);
  });
});
