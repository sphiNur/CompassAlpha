import { beforeAll, describe, expect, test } from 'bun:test';
import { createI18n, loadCatalog } from '@compass/i18n';
import { accessBlock, authErrorText, readsFinanceOnly } from '../authAccess';

beforeAll(async () => {
  await Promise.all([loadCatalog('en'), loadCatalog('zh')]);
});

describe('authErrorText (CMP-SHL-2)', () => {
  test('translates the key with the catalog current at render time', () => {
    const error = { key: 'auth.errors.invalidInitData' };
    // The same stored error reads in each language it is shown in.
    for (const i18n of [createI18n('en'), createI18n('zh')]) {
      expect(authErrorText(i18n, error)).toBe(i18n.t('auth.errors.invalidInitData'));
      expect(authErrorText(i18n, error)).not.toBe(i18n.t('auth.errors.signInFailed'));
    }
  });

  test('a development message without a key is shown as is', () => {
    expect(authErrorText({ t: (k) => k }, { key: 'auth.errors.signInFailed', raw: 'devAs: x' })).toBe(
      'devAs: x',
    );
  });
});

describe('accessBlock (CMP-SHL-1)', () => {
  const store = { id: 's1', name: 'A', code: null, isActive: true };
  test('staff without a store wait for a store', () => {
    expect(accessBlock({ permissions: ['order.submit'], stores: [] })).toBe('noStore');
  });
  test('an administrator needs no store assignment', () => {
    expect(accessBlock({ permissions: ['users.manage'], stores: [] })).toBeNull();
  });
  test('a store but no permission at all is no access', () => {
    expect(accessBlock({ permissions: [], stores: [store] })).toBe('noAccess');
  });
  test('a role and a store let the app open', () => {
    expect(accessBlock({ permissions: ['order.submit'], stores: [store] })).toBeNull();
  });
});

test('a key this build does not know reads as the generic failure (CMP-SHL-2)', () => {
  const en = createI18n('en');
  expect(authErrorText(en, { key: 'auth.errors.somethingNew' })).toBe(
    en.t('auth.errors.signInFailed'),
  );
});

describe('readsFinanceOnly (HIS-19)', () => {
  const finance = ['reports.view', 'prices.view'];
  test('finance without managing people: the report alone', () => {
    expect(readsFinanceOnly({ permissions: finance })).toBe(true);
  });
  test('a manager or a platform admin gets the whole Admin page', () => {
    expect(readsFinanceOnly({ permissions: [...finance, 'users.manage'] })).toBe(false);
    expect(readsFinanceOnly({ permissions: finance, isPlatformAdmin: true })).toBe(false);
  });
  test('no finance, or no session: not a finance reader', () => {
    expect(readsFinanceOnly({ permissions: ['order.draft'] })).toBe(false);
    expect(readsFinanceOnly(null)).toBe(false);
  });
});
