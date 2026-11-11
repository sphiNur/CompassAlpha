/**
 * Review RUNWEB1-07: the stand-ins behind useStableCallbacks keep their
 * identity and always reach the latest handler.
 */
import { describe, expect, it } from 'bun:test';
import { makeStandIns, withStandIns } from '../useStableCallbacks';

type Handlers = {
  onSave: (id: string) => string;
  onUndo?: (() => string) | undefined;
};

describe('stable callbacks', () => {
  it('calls the handler of the latest render, with its arguments', () => {
    let latest: Handlers = { onSave: (id) => `first ${id}` };
    const standIns = makeStandIns<Handlers>(['onSave', 'onUndo'], () => latest);
    const shown = withStandIns(latest, standIns);
    expect(shown.onSave('a')).toBe('first a');

    latest = { onSave: (id) => `second ${id}` };
    // The same function as before, reaching the new handler.
    expect(withStandIns(latest, standIns).onSave).toBe(shown.onSave);
    expect(shown.onSave('b')).toBe('second b');
  });

  it('keeps an absent handler absent, and brings it back when it returns', () => {
    let latest: Handlers = { onSave: () => '', onUndo: undefined };
    const standIns = makeStandIns<Handlers>(['onSave', 'onUndo'], () => latest);
    expect(withStandIns(latest, standIns).onUndo).toBeUndefined();

    latest = { onSave: () => '', onUndo: () => 'undone' };
    const shown = withStandIns(latest, standIns);
    // Its stand-in, not the handler itself.
    expect(shown.onUndo).toBeDefined();
    expect(shown.onUndo).not.toBe(latest.onUndo);
    expect(shown.onUndo!()).toBe('undone');
  });

  it('passes through a handler it has no stand-in for', () => {
    const onUndo = () => 'own';
    const shown = withStandIns<Handlers>({ onSave: () => '', onUndo }, {});
    expect(shown.onUndo).toBe(onUndo);
  });
});
