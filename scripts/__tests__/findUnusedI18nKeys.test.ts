import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findUnusedKeys, stripComments, walk } from '../find-unused-i18n-keys';

describe('find-unused-i18n-keys (R2-COPY-1)', () => {
  test('a key named only in a comment is unused', () => {
    const src = "// dropped run.banner.readyToStart\n/* 'run.banner.readyToStart' */ t('run.ok');";
    expect(findUnusedKeys(['run.banner.readyToStart', 'run.ok'], [src]).unused).toEqual([
      'run.banner.readyToStart',
    ]);
  });

  test('a key that is only the prefix of another key is unused', () => {
    const src = "t('settlement.expenses.itemNumber')";
    expect(
      findUnusedKeys(['settlement.expenses.item', 'settlement.expenses.itemNumber'], [src]).unused,
    ).toEqual(['settlement.expenses.item']);
  });

  test('a property path is not a key', () => {
    expect(findUnusedKeys(['auth.signOut'], ['trpc.auth.signOut.useMutation()']).unused).toEqual([
      'auth.signOut',
    ]);
  });

  test('computed prefixes still count as used', () => {
    const src = "t(('unit.' + u) as Key); t(`ops.event.${type}`);";
    expect(findUnusedKeys(['unit.kg', 'ops.event.Approved'], [src]).unused).toEqual([]);
  });

  test('a notification text counts only when its template is sent (I18N1-09)', () => {
    const src = "dispatch({ template: 'run.started' }); t(`notify.${envelope.template}.title`);";
    expect(
      findUnusedKeys(['notify.run.started.title', 'notify.run.dropped.title'], [src]).unused,
    ).toEqual(['notify.run.dropped.title']);
  });

  test('an attendance error counts only when fail() names it (I18N1-09)', () => {
    const src = "fail('BAD_REQUEST', 'tooLate'); const m = `attendance.errors.${key}`;";
    expect(
      findUnusedKeys(['attendance.errors.tooLate', 'attendance.errors.gone'], [src]).unused,
    ).toEqual(['attendance.errors.gone']);
  });

  test('test files are not read: a key only a test names is unused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unused-keys-'));
    try {
      mkdirSync(join(dir, '__tests__'));
      for (const f of ['page.tsx', 'page.test.tsx', '__tests__/helper.ts', 'notes.md'])
        writeFileSync(join(dir, f), '');
      expect(walk(dir).map((f) => f.slice(dir.length + 1))).toEqual(['page.tsx']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a URL is not a comment', () => {
    expect(stripComments("const u = 'https://x.y/a'; // note")).toBe("const u = 'https://x.y/a'; ");
  });
});
