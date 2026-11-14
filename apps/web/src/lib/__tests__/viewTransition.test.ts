/**
 * UI overhaul B (2026-11-15): a tab tap's view transition is an
 * enhancement; without the API, or with reduced motion, the update still
 * runs at once.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { withViewTransition } from '../viewTransition';

const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, window: g.window };

afterEach(() => {
  g.document = saved.document;
  g.window = saved.window;
});

function fakeDocument(start?: (arg: unknown) => { finished: Promise<void> }) {
  return {
    hidden: false,
    documentElement: { dataset: {} as Record<string, string> },
    startViewTransition: start,
  };
}

describe('withViewTransition', () => {
  test('runs the update directly when the browser has no view transitions', () => {
    g.document = fakeDocument();
    g.window = { matchMedia: () => ({ matches: false }) };
    let ran = 0;
    withViewTransition(() => ran++, 'tab', ['forward']);
    expect(ran).toBe(1);
  });

  test('runs the update directly under reduced motion', () => {
    let started = 0;
    g.document = fakeDocument(() => {
      started++;
      return { finished: Promise.resolve() };
    });
    g.window = { matchMedia: () => ({ matches: true }) };
    let ran = 0;
    withViewTransition(() => ran++, 'tab');
    expect({ ran, started }).toEqual({ ran: 1, started: 0 });
  });

  test('starts a transition and marks its scope until it ends', async () => {
    const doc = fakeDocument((arg) => {
      (typeof arg === 'function' ? arg : (arg as { update: () => void }).update)();
      return { finished: Promise.resolve() };
    });
    g.document = doc;
    g.window = { matchMedia: () => ({ matches: false }) };
    let ran = 0;
    withViewTransition(() => ran++, 'tab');
    expect(ran).toBe(1);
    expect(doc.documentElement.dataset.vt).toBe('tab');
    await Promise.resolve();
    await Promise.resolve();
    expect(doc.documentElement.dataset.vt).toBeUndefined();
  });
});
