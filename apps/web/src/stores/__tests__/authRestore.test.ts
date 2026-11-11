import { describe, expect, test } from 'bun:test';
import { testSession } from '../../__tests__/fixtures/session';
import { isUsableSession, mergePersistedAuth } from '../authStore';
import type { PersistedAuth } from '../authStore';

/** DX-SHL-16: a broken stored session is dropped instead of crashing the app. */
const session = testSession();
const current: PersistedAuth & { marker: number } = {
  accessToken: null,
  refreshToken: null,
  session: null,
  currentStoreId: null,
  marker: 1,
};

describe('restoring the stored session (DX-SHL-16)', () => {
  test('a well-formed session is restored with its tokens and store', () => {
    const out = mergePersistedAuth(
      { accessToken: 'a', refreshToken: 'r', session, currentStoreId: 's1' },
      current,
    );
    expect(out.session).toEqual(session);
    expect(out.accessToken).toBe('a');
    expect(out.currentStoreId).toBe('s1');
    expect(out.marker).toBe(1);
  });

  test('stores: null (the crash seen in the audit) drops the session', () => {
    const out = mergePersistedAuth(
      { accessToken: 'a', refreshToken: 'r', session: { ...session, stores: null }, currentStoreId: 's1' },
      current,
    );
    expect(out).toBe(current);
  });

  test('permissions that are not a string list drop the session', () => {
    expect(isUsableSession({ ...session, permissions: 'order.draft' })).toBe(false);
    expect(isUsableSession({ ...session, user: null })).toBe(false);
    expect(isUsableSession(null)).toBe(false);
  });

  test('a store the session no longer has falls back to its first store', () => {
    const out = mergePersistedAuth({ accessToken: 'a', refreshToken: 'r', session, currentStoreId: 'gone' }, current);
    expect(out.currentStoreId).toBe('s1');
  });

  // COREAPI-33: the session type is the server's, whose languages are the
  // four. Sessions saved by older builds are read as the server reads them.
  test('a raw Telegram language and a missing second language are read as one of the four', () => {
    const old = {
      ...session,
      user: { ...session.user, locale: 'zh-hans', secondaryLocale: undefined },
    };
    const out = mergePersistedAuth(
      { accessToken: 'a', refreshToken: 'r', session: old, currentStoreId: 's1' },
      current,
    );
    expect(out.session?.user.locale).toBe('zh');
    expect(out.session?.user.secondaryLocale).toBeNull();
    const withSecond = {
      ...session,
      user: { ...session.user, locale: 'en', secondaryLocale: 'ru-RU' },
    };
    const out2 = mergePersistedAuth(
      { accessToken: 'a', refreshToken: 'r', session: withSecond, currentStoreId: 's1' },
      current,
    );
    expect(out2.session?.user.secondaryLocale).toBe('ru');
  });
});
