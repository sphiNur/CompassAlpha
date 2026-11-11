import { describe, expect, test } from 'bun:test';
import { stepDraftChange, type OpenedDraft } from '../useDraftChanged';

/** Feeds the steps in order, as renders would, and returns each answer. */
function run(steps: Array<[string | null, string | null]>): boolean[] {
  let opened: OpenedDraft = null;
  return steps.map(([identity, snapshot]) => {
    const step = stepDraftChange(opened, identity, snapshot);
    opened = step.opened;
    return step.changed;
  });
}

describe('stepDraftChange (CMP-BUY-4, ADM2-11)', () => {
  test('a sheet as it opened has no changes; typing makes one; undoing it clears it', () => {
    expect(
      run([
        ['sku-1', '{"qty":""}'],
        ['sku-1', '{"qty":"2"}'],
        ['sku-1', '{"qty":""}'],
      ]),
    ).toEqual([false, true, false]);
  });

  test('opening another row starts from its own values', () => {
    expect(
      run([
        ['sku-1', '{"qty":"2"}'],
        ['sku-2', '{"qty":"5"}'],
      ]),
    ).toEqual([false, false]);
  });

  test('a closed sheet forgets, so reopening the same row is unchanged', () => {
    expect(
      run([
        ['sku-1', '{"qty":""}'],
        ['sku-1', '{"qty":"3"}'],
        [null, null],
        ['sku-1', '{"qty":"3"}'],
      ]),
    ).toEqual([false, true, false, false]);
  });

  test('the kept snapshot is the same object while nothing opens or closes', () => {
    const first = stepDraftChange(null, 'sku-1', '{"qty":""}');
    const again = stepDraftChange(first.opened, 'sku-1', '{"qty":"4"}');
    // The hook sets state only when this object changes, so a render that
    // follows a keystroke sets nothing.
    expect(again.opened).toBe(first.opened);
  });
});
