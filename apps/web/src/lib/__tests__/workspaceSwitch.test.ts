import { describe, expect, test } from 'bun:test';
import { mayLeaveWorkspace } from '../workspaceSwitch';

/**
 * DX-SHL-3 / D7: switching workspace asks only about writes still waiting
 * to be sent, then lets the draft guards veto.
 */
describe('mayLeaveWorkspace', () => {
  const calls: string[] = [];
  const deps = (answers: { waiting: number; confirm: boolean; tab: boolean; store: boolean }) => ({
    waitingWrites: async () => answers.waiting,
    confirmWaiting: async (n: number) => (calls.push(`confirm:${n}`), answers.confirm),
    requestTabChange: async (next: string) => (calls.push(`tab:${next}`), answers.tab),
    requestStoreChange: async (next: null) => (calls.push(`store:${next}`), answers.store),
  });

  test('nothing waiting: no question, only the guards', async () => {
    calls.length = 0;
    expect(
      await mayLeaveWorkspace(deps({ waiting: 0, confirm: false, tab: true, store: true })),
    ).toBe(true);
    expect(calls).toEqual(['tab:order', 'store:null']);
  });

  test('writes waiting: asks first; "no" stops before any guard', async () => {
    calls.length = 0;
    expect(
      await mayLeaveWorkspace(deps({ waiting: 2, confirm: false, tab: true, store: true })),
    ).toBe(false);
    expect(calls).toEqual(['confirm:2']);
  });

  test('an unsaved daily close (tab guard) vetoes the switch', async () => {
    calls.length = 0;
    expect(
      await mayLeaveWorkspace(deps({ waiting: 1, confirm: true, tab: false, store: true })),
    ).toBe(false);
    expect(calls).toEqual(['confirm:1', 'tab:order']);
  });

  test('the store guard is asked too', async () => {
    calls.length = 0;
    expect(
      await mayLeaveWorkspace(deps({ waiting: 0, confirm: true, tab: true, store: false })),
    ).toBe(false);
    expect(calls).toEqual(['tab:order', 'store:null']);
  });
});
