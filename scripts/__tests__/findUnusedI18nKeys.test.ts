import { describe, expect, test } from 'bun:test';
import { findUnusedKeys, stripComments } from '../find-unused-i18n-keys';

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

  test('a URL is not a comment', () => {
    expect(stripComments("const u = 'https://x.y/a'; // note")).toBe("const u = 'https://x.y/a'; ");
  });
});
