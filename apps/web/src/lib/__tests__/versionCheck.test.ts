/**
 * Review TEST3-08 (2026-11-10): what happens when a deploy lands while the
 * app is open had no test. FE-05 (2026-10-21): a visible app is never
 * reloaded on its own; only a hidden app with nothing to lose is.
 */
import { describe, expect, test } from 'bun:test';
import { HIDDEN_BEFORE_AUTO_RELOAD_MS } from '../reload';
import { versionCheck, type VersionCheckDeps } from '../versionCheck';

/**
 * An app on build "a", visible, with nothing open or waiting. `server` is
 * what /health/version answers (null: no answer, an Error: a network error).
 */
function app(start: { hidden?: boolean } = {}, over: Partial<VersionCheckDeps> = {}) {
  const state = {
    clock: 1_000_000,
    hidden: start.hidden ?? false,
    server: 'a' as string | null | Error,
  };
  const prompts: Array<() => void> = [];
  const reloads: string[] = [];
  let asked = 0;
  const versions = versionCheck({
    running: 'a',
    async serverBuild() {
      asked++;
      if (state.server instanceof Error) throw state.server;
      return state.server;
    },
    now: () => state.clock,
    hidden: () => state.hidden,
    queuedWrites: async () => 0,
    openSheets: () => 0,
    mutationsInFlight: () => 0,
    prompt: (reload) => void prompts.push(reload),
    reload: (reason) => void reloads.push(reason),
    ...over,
  });
  return {
    versions,
    state,
    prompts,
    reloads,
    asked: () => asked,
    wait(ms: number) {
      state.clock += ms;
    },
    hide() {
      state.hidden = true;
      versions.visibilityChanged();
    },
    show() {
      state.hidden = false;
      versions.visibilityChanged();
    },
  };
}

/** An app that has seen build "b" and was hidden for long enough. */
async function hiddenWithUpdate(over: Partial<VersionCheckDeps> = {}) {
  const a = app({}, over);
  a.state.server = 'b';
  await a.versions.check();
  a.hide();
  a.wait(HIDDEN_BEFORE_AUTO_RELOAD_MS);
  return a;
}

describe('versionCheck: the prompt', () => {
  test('the same build: nothing', async () => {
    const a = app();
    await a.versions.check();
    expect(a.prompts).toHaveLength(0);
  });

  test('a new build: one prompt, and the server is not asked again', async () => {
    const a = app();
    a.state.server = 'b';
    await a.versions.check();
    await a.versions.check();
    await a.versions.check();
    expect(a.prompts).toHaveLength(1);
    expect(a.asked()).toBe(1);
  });

  test('no answer or a network error: nothing, and the next poll asks again', async () => {
    const a = app();
    a.state.server = null;
    await a.versions.check();
    a.state.server = new Error('Failed to fetch');
    await a.versions.check();
    expect(a.prompts).toHaveLength(0);
    a.state.server = 'b';
    await a.versions.check();
    expect(a.prompts).toHaveLength(1);
  });

  test('its Reload button reloads, as asked for by the user', async () => {
    const a = app();
    a.state.server = 'b';
    await a.versions.check();
    a.prompts[0]!();
    expect(a.reloads).toEqual(['update-accepted']);
  });
});

describe('versionCheck: reloading without being asked', () => {
  test('never while the app is visible', async () => {
    const a = app();
    a.state.server = 'b';
    await a.versions.check();
    a.wait(60 * 60_000);
    await a.versions.check();
    await a.versions.check();
    expect(a.reloads).toEqual([]);
  });

  test('a hidden app with nothing to lose reloads after the wait, not before', async () => {
    const a = app();
    a.state.server = 'b';
    await a.versions.check();
    a.hide();
    a.wait(HIDDEN_BEFORE_AUTO_RELOAD_MS - 1);
    await a.versions.check();
    expect(a.reloads).toEqual([]);
    a.wait(1);
    await a.versions.check();
    expect(a.reloads).toEqual(['update-while-hidden']);
  });

  test('not with a sheet open, a write in flight or a write queued offline', async () => {
    for (const over of [
      { openSheets: () => 1 },
      { mutationsInFlight: () => 1 },
      { queuedWrites: async () => 2 },
    ]) {
      const a = await hiddenWithUpdate(over);
      await a.versions.check();
      expect(a.reloads).toEqual([]);
    }
  });

  test('an offline queue that cannot be read counts as empty', async () => {
    const a = await hiddenWithUpdate({
      queuedWrites: () => Promise.reject(new Error('IDB unavailable')),
    });
    await a.versions.check();
    expect(a.reloads).toEqual(['update-while-hidden']);
  });

  test('not when the app is shown again while the queue is read', async () => {
    const a = await hiddenWithUpdate({
      queuedWrites: async () => {
        a.show();
        return 0;
      },
    });
    await a.versions.check();
    expect(a.reloads).toEqual([]);
  });

  test('showing the app restarts the wait', async () => {
    const a = await hiddenWithUpdate();
    a.show();
    a.hide();
    await a.versions.check();
    expect(a.reloads).toEqual([]);
  });

  test('an app that starts hidden counts from its start', async () => {
    const a = app({ hidden: true });
    a.wait(HIDDEN_BEFORE_AUTO_RELOAD_MS);
    a.state.server = 'b';
    await a.versions.check();
    await a.versions.check();
    expect(a.reloads).toEqual(['update-while-hidden']);
  });
});
