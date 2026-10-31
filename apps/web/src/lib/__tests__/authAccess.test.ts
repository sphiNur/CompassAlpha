import { describe, expect, test } from 'bun:test';
import { accessBlock, authErrorText } from '../authAccess';

describe('authErrorText (CMP-SHL-2)', () => {
  test('translates the key with the catalog current at render time', () => {
    const error = { key: 'auth.errors.invalidInitData' };
    // Before the zh catalog has loaded the lookup falls back to English…
    expect(authErrorText({ t: () => 'Telegram session is invalid' }, error)).toBe(
      'Telegram session is invalid',
    );
    // …and the same stored error reads in Chinese once it has.
    expect(authErrorText({ t: () => 'Telegram 会话无效' }, error)).toBe('Telegram 会话无效');
  });

  test('a development message without a key is shown as is', () => {
    expect(authErrorText({ t: (k) => k }, { key: 'auth.errors.signInFailed', raw: 'devAs: x' })).toBe(
      'devAs: x',
    );
  });
});

describe('accessBlock (CMP-SHL-1)', () => {
  const store = { id: 's1', name: 'A' } as never;
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
  const t = (k: string) => (k === 'auth.errors.signInFailed' ? 'Sign in failed' : k);
  expect(authErrorText({ t }, { key: 'auth.errors.somethingNew' })).toBe('Sign in failed');
});
