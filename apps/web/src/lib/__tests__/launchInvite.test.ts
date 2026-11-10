import { describe, expect, it } from 'bun:test';
import { inviteSettled, markInviteSettled } from '../launchInvite';

function memoryStore() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

describe('launch invite, settled once per launch (COREWEB1-03)', () => {
  it('a reload of the same launch skips the invite it settled', () => {
    const store = memoryStore();
    expect(inviteSettled('inv_a', store)).toBe(false);
    markInviteSettled('inv_a', store);
    expect(inviteSettled('inv_a', store)).toBe(true);
  });

  it('another invite is still taken', () => {
    const store = memoryStore();
    markInviteSettled('inv_a', store);
    expect(inviteSettled('inv_b', store)).toBe(false);
  });

  it('without storage, behaves as before: the invite is taken', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(() => markInviteSettled('inv_a', broken)).not.toThrow();
    expect(inviteSettled('inv_a', broken)).toBe(false);
    expect(inviteSettled('inv_a', null)).toBe(false);
  });
});
