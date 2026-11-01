import { describe, expect, test } from 'bun:test';
import { isUsableSession, mergePersistedAuth } from '../authStore';

/** DX-SHL-16: a broken stored session is dropped instead of crashing the app. */
const session = {
  user: { id: 'u1', displayName: 'A', displayNameLocked: false, avatarUrl: null, locale: 'zh', secondaryLocale: null, tgUsername: null },
  member: { memberId: 'm1', orgId: 'o1', orgSlug: 'o', orgName: 'Org', status: 'active' },
  stores: [{ id: 's1', name: 'Store', code: null, isActive: true }],
  permissions: ['order.draft'],
  roleSlugs: ['staff'],
  myMaxRank: 10,
  needsOnboarding: false,
};
const current = { accessToken: null, refreshToken: null, session: null, currentStoreId: null, marker: 1 };

describe('restoring the stored session (DX-SHL-16)', () => {
  test('a well-formed session is restored with its tokens and store', () => {
    const out = mergePersistedAuth(
      { accessToken: 'a', refreshToken: 'r', session, currentStoreId: 's1' },
      current,
    );
    expect(out.session).toEqual(session as never);
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
});
