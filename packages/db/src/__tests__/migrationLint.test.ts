/**
 * Review DB-01 (2026-11-09): migrations may not BEGIN or COMMIT.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_TRANSACTION_CONTROL,
  transactionControl,
  transactionControlViolations,
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
