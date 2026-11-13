import { describe, expect, it } from 'bun:test';
import { memoryStorage, throwingStorage } from '../../__tests__/helpers/storage';
import { inviteSettled, markInviteSettled } from '../launchInvite';

describe('launch invite, settled once per launch (COREWEB1-03)', () => {
  it('a reload of the same launch skips the invite it settled', () => {
    const store = memoryStorage();
    expect(inviteSettled('inv_a', store)).toBe(false);
    markInviteSettled('inv_a', store);
    expect(inviteSettled('inv_a', store)).toBe(true);
  });

  it('another invite is still taken', () => {
    const store = memoryStorage();
    markInviteSettled('inv_a', store);
    expect(inviteSettled('inv_b', store)).toBe(false);
  });

  it('without storage, behaves as before: the invite is taken', () => {
    const broken = throwingStorage();
    expect(() => markInviteSettled('inv_a', broken)).not.toThrow();
    expect(inviteSettled('inv_a', broken)).toBe(false);
    expect(inviteSettled('inv_a', null)).toBe(false);
  });
});
