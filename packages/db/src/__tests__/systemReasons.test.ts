/**
 * D3 (2026-10-30): app_is_system() accepts only the SystemReason values
 * the code sets, so a made-up app.system_context reads no tenant's rows.
 * This checks that the function in the migrations lists exactly
 * SYSTEM_REASONS; the api's event-store-guard.test.ts (PG-gated) checks
 * that a migrated database accepts each of them and nothing else.
 *
 * Moved here from the api's tests (review TEST1-16, 2026-11), where it
 * read this package's SQL by a relative path. It also took the first
 * `IN (` after the function's name for its list, so a body written any
 * other way failed with an unrelated message.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_REASONS } from '../rls';

const POLICIES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/sql/900_rls_policies.sql',
);

/**
 * The string literals in the body of each `FUNCTION app_is_system()` in
 * `sql`, whatever its dollar-quote tag and layout.
 */
function systemFunctionLiterals(sql: string): string[][] {
  const bodies = sql.matchAll(/FUNCTION\s+app_is_system\s*\(\s*\)[^$]*\$(\w*)\$([\s\S]*?)\$\1\$/gi);
  return [...bodies].map((m) =>
    [...m[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((l) => l[1]!.replace(/''/g, "'")),
  );
}

test('app_is_system() lists exactly SYSTEM_REASONS', () => {
  const definitions = systemFunctionLiterals(readFileSync(POLICIES, 'utf8'));
  expect(definitions).toHaveLength(1);
  // Besides the reasons, the body names the setting it reads and the
  // empty string it falls back to when the setting is unset.
  const reasons = definitions[0]!.filter((l) => l !== 'app.system_context' && l !== '');
  expect(reasons.sort()).toEqual([...SYSTEM_REASONS].sort());
});

test('the parse finds a list however the body is written', () => {
  const tagged = `
    CREATE FUNCTION app_is_system() RETURNS boolean AS $fn$
      SELECT lower(coalesce(current_setting('app.system_context', true), ''))
        = ANY (ARRAY['worker', 'it''s'])
    $fn$ LANGUAGE SQL;`;
  expect(systemFunctionLiterals(tagged)).toEqual([['app.system_context', '', 'worker', "it's"]]);
  expect(systemFunctionLiterals('CREATE FUNCTION app_current_org() AS $$ $$')).toEqual([]);
});
