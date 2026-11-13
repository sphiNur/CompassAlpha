import { describe, expect, test } from 'bun:test';
import { inviteStoreChoice } from '../inviteStores';

const A = { id: 'a', name: 'Riverside', code: 'RS' };
const B = { id: 'b', name: 'Central', code: 'CK' };
const C = { id: 'c', name: 'Harbour', code: 'HB' };

describe('the stores the Admin home invites into', () => {
  test('none: the person may not invite anywhere', () => {
    expect(inviteStoreChoice([A, B], new Set(), 'a')).toEqual({ stores: [], preselect: null });
  });

  test('one: that store, whatever the top bar shows', () => {
    expect(inviteStoreChoice([A, B, C], new Set(['b']), 'a')).toEqual({
      stores: [{ id: 'b', name: 'Central' }],
      preselect: 'b',
    });
  });

  test('several: the top-bar store first, in the session order', () => {
    expect(inviteStoreChoice([A, B, C], new Set(['a', 'c']), 'c')).toEqual({
      stores: [
        { id: 'a', name: 'Riverside' },
        { id: 'c', name: 'Harbour' },
      ],
      preselect: 'c',
    });
  });

  test('several, top bar on another store or all stores: the person picks', () => {
    expect(inviteStoreChoice([A, B, C], new Set(['a', 'c']), 'b').preselect).toBeNull();
    expect(inviteStoreChoice([A, B, C], new Set(['a', 'c']), null).preselect).toBeNull();
  });
});
