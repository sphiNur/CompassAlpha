import { describe, expect, it } from 'bun:test';
import { canSwitchStore } from '../../components/StoreSwitcher';
import type { AuthSession } from '../../stores/authStore';

const store = (id: string) => ({ id, name: id, code: null, isActive: true });
const session = (permissions: string[], stores: AuthSession['stores']) =>
  ({ permissions, stores }) as unknown as AuthSession;

describe('canSwitchStore', () => {
  it('lets org admins switch even with a single store', () => {
    expect(canSwitchStore(session(['org.admin'], [store('a')]))).toBe(true);
  });
  it('lets a non-admin with two or more stores switch', () => {
    expect(canSwitchStore(session(['users.manage'], [store('a'), store('b')]))).toBe(true);
  });
  it('keeps a single-store non-admin pinned', () => {
    expect(canSwitchStore(session(['users.manage'], [store('a')]))).toBe(false);
    expect(canSwitchStore(null)).toBe(false);
  });
});
