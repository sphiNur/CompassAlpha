import { describe, expect, test } from 'bun:test';
import { mayLeaveWorkspace } from '../SettingsSheet';

/** DX-SHL-3: switching workspace asks, then lets the draft guards veto. */
describe('mayLeaveWorkspace', () => {
  const calls: string[] = [];
  const deps = (answers: { confirm: boolean; tab: boolean; store: boolean }) => ({
    confirm: async () => (calls.push('confirm'), answers.confirm),
    requestTabChange: async (next: string) => (calls.push(`tab:${next}`), answers.tab),
    requestStoreChange: async (next: null) => (calls.push(`store:${next}`), answers.store),
  });

  test('asks first; "no" stops before any guard', async () => {
    calls.length = 0;
    expect(await mayLeaveWorkspace(deps({ confirm: false, tab: true, store: true }))).toBe(false);
    expect(calls).toEqual(['confirm']);
  });

  test('an unsaved daily close (tab guard) vetoes the switch', async () => {
    calls.length = 0;
    expect(await mayLeaveWorkspace(deps({ confirm: true, tab: false, store: true }))).toBe(false);
    expect(calls).toEqual(['confirm', 'tab:order']);
  });

  test('the store guard is asked too', async () => {
    calls.length = 0;
    expect(await mayLeaveWorkspace(deps({ confirm: true, tab: true, store: false }))).toBe(false);
    expect(calls).toEqual(['confirm', 'tab:order', 'store:null']);
  });

  test('all yes: the switch goes ahead', async () => {
    expect(await mayLeaveWorkspace(deps({ confirm: true, tab: true, store: true }))).toBe(true);
  });
});
