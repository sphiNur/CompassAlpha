import { describe, expect, test } from 'bun:test';
import { savedTab } from '../../app/pageChunks';

const storage = (items: Record<string, unknown>) => ({
  getItem: (key: string) => (key in items ? JSON.stringify(items[key]) : null),
});
const signedIn = { state: { session: { user: { id: 'u' } } } };

describe('savedTab (DX-PFE-3: preload the page the app reopens on)', () => {
  test('the persisted tab of a signed-in person', () => {
    expect(savedTab(storage({ 'compass.auth': signedIn, 'compass.nav.v1': { state: { tab: 'run' } } }))).toBe(
      'run',
    );
    expect(
      savedTab(storage({ 'compass.auth': signedIn, 'compass.nav.v1': { state: { tab: 'approve' } } })),
    ).toBe('approve');
  });

  test('nothing to preload: the order tab is in the entry chunk', () => {
    expect(
      savedTab(storage({ 'compass.auth': signedIn, 'compass.nav.v1': { state: { tab: 'order' } } })),
    ).toBeNull();
  });

  test('no session, no saved tab or junk: null', () => {
    expect(savedTab(storage({ 'compass.nav.v1': { state: { tab: 'run' } } }))).toBeNull();
    expect(savedTab(storage({ 'compass.auth': { state: { session: null } }, 'compass.nav.v1': { state: { tab: 'run' } } }))).toBeNull();
    expect(savedTab(storage({ 'compass.auth': signedIn }))).toBeNull();
    expect(savedTab(storage({ 'compass.auth': signedIn, 'compass.nav.v1': { state: { tab: 'nope' } } }))).toBeNull();
    expect(savedTab({ getItem: () => '{bad' })).toBeNull();
  });
});
