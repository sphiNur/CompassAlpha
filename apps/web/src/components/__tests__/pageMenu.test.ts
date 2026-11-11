/**
 * Review COREWEB1-13 (2026-11-12): a page-menu action registered by one
 * render runs the handler of the latest render when it is clicked.
 */
import { describe, expect, it } from 'bun:test';
import { liveRegistration, type PageMenuRegistration } from '../PageMenuContext';

function menu(onClick: () => void): PageMenuRegistration {
  return { title: 'Run', actions: [{ label: 'Finish', onClick }] };
}

describe('liveRegistration', () => {
  it('runs the latest render’s handler, not the one it was stored with', () => {
    const calls: string[] = [];
    let latest = menu(() => calls.push('first render'));
    const stored = liveRegistration(latest, () => latest);
    latest = menu(() => calls.push('latest render'));
    stored!.actions[0]!.onClick();
    expect(calls).toEqual(['latest render']);
  });

  it('keeps the labels, and does nothing once the page has unregistered', () => {
    let latest: PageMenuRegistration | null = menu(() => {
      throw new Error('must not run');
    });
    const stored = liveRegistration(latest, () => latest);
    expect(stored!.actions.map((a) => a.label)).toEqual(['Finish']);
    latest = null;
    expect(() => stored!.actions[0]!.onClick()).not.toThrow();
  });

  it('stores nothing for no registration', () => {
    expect(liveRegistration(null, () => null)).toBeNull();
  });
});
