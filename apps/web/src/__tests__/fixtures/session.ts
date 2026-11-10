/**
 * A complete, well-formed session for tests (review TEST3-01: partial
 * sessions cast `as never` hid type drift from the checker).
 */
import type { AuthSession } from '../../stores/authStore';

export function testSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    user: {
      id: 'u1',
      displayName: 'A',
      displayNameLocked: false,
      avatarUrl: null,
      locale: 'zh',
      secondaryLocale: null,
      tgUsername: null,
    },
    member: { memberId: 'm1', orgId: 'o1', orgSlug: 'o', orgName: 'Org', status: 'active' },
    stores: [{ id: 's1', name: 'Store', code: null, isActive: true }],
    permissions: ['order.draft'],
    roleSlugs: ['staff'],
    myMaxRank: 10,
    needsOnboarding: false,
    ...overrides,
  };
}
