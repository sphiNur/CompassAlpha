/**
 * Review DB-01 (2026-11-09): migrations may not BEGIN or COMMIT.
 * Review DB-07 (2026-11-10): the journal stays in order, and no database
 * passes over an entry.
 * Review OPS-10 (2026-11): the deploy knows which entries are pending.
 * Review DB-10 (2026-11-11): an index name belongs to one table.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_INDEX_NAME_REUSE,
  LEGACY_TRANSACTION_CONTROL,
  indexNameReuse,
  indexStatements,
  journalOrderProblems,
  pendingMigrations,
  transactionControl,
  transactionControlViolations,
  unreachableMigrations,
  type JournalEntry,
} from '../migrationLint';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

describe('transactionControl', () => {
  test('finds statements that open or end a transaction', () => {
    const sql = [
      'BEGIN;',
      'UPDATE a SET b = 1;',
      '  commit ;',
      'START TRANSACTION;',
      'ROLLBACK WORK;',
      'COMMIT TRANSACTION;',
    ].join('\n');
    expect(transactionControl(sql)).toEqual([
      'BEGIN;',
      'commit ;',
      'START TRANSACTION;',
      'ROLLBACK WORK;',
      'COMMIT TRANSACTION;',
    ]);
  });

  test('leaves PL/pgSQL blocks, comments and ON COMMIT alone', () => {
    const sql = [
      '-- COMMIT;',
      'DO $$',
      'BEGIN',
      '  IF true THEN',
      '    BEGIN',
      '      PERFORM 1;',
      '    END;',
      '  END IF;',
      'END',
      '$$;',
      'CREATE TEMP TABLE t ON COMMIT DROP AS SELECT 1;',
    ].join('\n');
    expect(transactionControl(sql)).toEqual([]);
  });
});

describe('the migrations folder', () => {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((f) => ({ tag: f.replace(/\.sql$/, ''), sql: readFileSync(join(MIGRATIONS, f), 'utf8') }));

  test('no migration outside the legacy list controls the transaction', () => {
    expect(transactionControlViolations(files)).toEqual([]);
  });

  test('the legacy list is exact: each entry exists and still does', () => {
    const byTag = new Map(files.map((f) => [f.tag, f.sql]));
    for (const tag of LEGACY_TRANSACTION_CONTROL) {
      expect(byTag.has(tag)).toBe(true);
      expect(transactionControl(byTag.get(tag) ?? '').length).toBeGreaterThan(0);
    }
  });

  test('a new file with its own COMMIT is refused', () => {
    expect(
      transactionControlViolations([{ tag: '9999_new', sql: 'BEGIN;\nSELECT 1;\nCOMMIT;' }]),
    ).toEqual([{ tag: '9999_new', statements: ['BEGIN;', 'COMMIT;'] }]);
  });
});

const entry = (idx: number, when: number): JournalEntry => ({
  idx,
  when,
  tag: `${String(idx).padStart(4, '0')}_x`,
});

describe('journalOrderProblems', () => {
  test('accepts idx counting up from 0 and a growing when', () => {
    expect(journalOrderProblems([entry(0, 10), entry(1, 11), entry(2, 20)])).toEqual([]);
  });

  test('flags a gap in idx', () => {
    expect(journalOrderProblems([entry(0, 10), entry(2, 11)])).toEqual([
      '0002_x: idx is 2, expected 1',
    ]);
  });

  test('flags a when that does not grow', () => {
    expect(journalOrderProblems([entry(0, 10), entry(1, 10)])).toEqual([
      "0001_x: when 10 is not after 0000_x's 10",
    ]);
    expect(journalOrderProblems([entry(0, 10), entry(1, 9)])).toEqual([
      "0001_x: when 9 is not after 0000_x's 10",
    ]);
  });
});

describe('unreachableMigrations', () => {
  const journal = [entry(0, 10), entry(1, 20), entry(2, 30), entry(3, 40)];

  test('a new database has nothing to pass over', () => {
    expect(unreachableMigrations(journal, [])).toEqual([]);
  });

  test('entries after the newest recorded one are pending, not passed over', () => {
    expect(unreachableMigrations(journal, [10, 20])).toEqual([]);
  });

  test('an unrecorded entry dated before the newest recorded one is passed over', () => {
    // 0001 merged after 0002 had been deployed.
    expect(unreachableMigrations(journal, [10, 30])).toEqual([entry(1, 20)]);
  });
});

describe('pendingMigrations', () => {
  const journal = [entry(0, 10), entry(1, 20), entry(2, 30)];

  test('a new database applies every entry', () => {
    expect(pendingMigrations(journal, [])).toEqual(journal);
  });

  test('only the entries after the newest recorded one', () => {
    expect(pendingMigrations(journal, [10])).toEqual([entry(1, 20), entry(2, 30)]);
    expect(pendingMigrations(journal, [10, 20, 30])).toEqual([]);
  });

  test('not one the database passed over (see unreachableMigrations)', () => {
    expect(pendingMigrations(journal, [10, 30])).toEqual([]);
  });
});

describe('the journal', () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };

  test('is in order', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(journalOrderProblems(journal.entries)).toEqual([]);
  });
});

describe('indexStatements', () => {
  test('reads quoted and plain names, in order, lower-cased', () => {
    const sql = [
      'CREATE INDEX IF NOT EXISTS "Apr_Org_Idx" ON "inventory"."attendance_pay_rates" USING btree ("org_id");',
      '-- CREATE INDEX commented_out ON inventory.x (a);',
      'CREATE UNIQUE INDEX CONCURRENTLY one_key ON ONLY read_model.v (a, b);',
      'DROP INDEX IF EXISTS read_model.old_idx;',
      'DROP INDEX CONCURRENTLY "read_model"."older_idx";',
    ].join('\n');
    expect(indexStatements(sql)).toEqual([
      { op: 'create', index: 'inventory.apr_org_idx', table: 'inventory.attendance_pay_rates' },
      { op: 'create', index: 'read_model.one_key', table: 'read_model.v' },
      { op: 'drop', index: 'read_model.old_idx' },
      { op: 'drop', index: 'read_model.older_idx' },
    ]);
  });
});

describe('indexNameReuse', () => {
  const file = (tag: string, ...sql: string[]) => ({ tag, sql: sql.join('\n') });

  test('a name another table of the schema has is reported', () => {
    expect(
      indexNameReuse(
        [
          file('0001_a', 'CREATE INDEX IF NOT EXISTS org_idx ON inventory.a (org_id);'),
          file('0002_b', 'CREATE INDEX IF NOT EXISTS org_idx ON inventory.b (org_id);'),
        ],
        new Set(),
      ),
    ).toEqual([
      { tag: '0002_b', index: 'inventory.org_idx', tables: ['inventory.a', 'inventory.b'] },
    ]);
  });

  test('the same index again, the same name in another schema, or a dropped name is fine', () => {
    expect(
      indexNameReuse(
        [
          file('0001_a', 'CREATE INDEX org_idx ON inventory.a (org_id);'),
          file('0002_a', 'CREATE INDEX IF NOT EXISTS org_idx ON inventory.a (org_id);'),
          file('0003_c', 'CREATE INDEX org_idx ON read_model.c (org_id);'),
          file(
            '0004_b',
            'DROP INDEX IF EXISTS inventory.org_idx;',
            'CREATE INDEX org_idx ON inventory.b (org_id);',
          ),
        ],
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe('index names in the migrations folder', () => {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ tag: f.replace(/\.sql$/, ''), sql: readFileSync(join(MIGRATIONS, f), 'utf8') }));

  test('no migration gives an index name to a second table', () => {
    expect(indexNameReuse(files)).toEqual([]);
  });

  test('the legacy list is exact: each entry is still a reuse, and nothing else is', () => {
    const all = indexNameReuse(files, new Set()).map((p) => `${p.tag} ${p.index}`);
    expect(all).toEqual([...LEGACY_INDEX_NAME_REUSE]);
  });

  test('0069 gives attendance_punch_reviews its own org index', () => {
    const byTag = new Map(files.map((f) => [f.tag, f.sql]));
    expect(indexStatements(byTag.get('0069_attendance_review_org_index') ?? '')).toEqual([
      {
        op: 'create',
        index: 'inventory.apr_reviews_org_idx',
        table: 'inventory.attendance_punch_reviews',
      },
    ]);
  });
});
