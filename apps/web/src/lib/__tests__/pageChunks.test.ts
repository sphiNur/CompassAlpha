import { describe, expect, test } from 'bun:test';
import { preloadPage, savedTab } from '../../app/pageChunks';

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

  test("Object.prototype's names are not tabs (review COREWEB1-11)", () => {
    // `"toString" in PAGE_IMPORTS` was true: main.tsx then called
    // Object.prototype.toString as the page import and threw at start.
    for (const tab of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const nav = { state: { tab } };
      expect(savedTab(storage({ 'compass.auth': signedIn, 'compass.nav.v1': nav }))).toBeNull();
    }
    expect(() => preloadPage('order')).not.toThrow();
  });
});
