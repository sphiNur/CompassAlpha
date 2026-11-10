/**
 * Review DB-01 (2026-11-09): migrations may not BEGIN or COMMIT.
 * Review DB-07 (2026-11-10): the journal stays in order, and no database
 * passes over an entry.
 * Review OPS-10 (2026-11): the deploy knows which entries are pending.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_TRANSACTION_CONTROL,
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
