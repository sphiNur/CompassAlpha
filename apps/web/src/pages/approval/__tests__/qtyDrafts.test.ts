import { describe, expect, it } from 'bun:test';
import { QtyDrafts } from '../qtyDrafts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('QtyDrafts (DX-APR-2)', () => {
  it('three quick taps send one write with the final value', async () => {
    const sent: Array<[string, number]> = [];
    const drafts = new QtyDrafts(
      async (key, value) => {
        sent.push([key, value]);
      },
      () => {},
      20,
    );
    drafts.set('banana', 3.5);
    drafts.set('banana', 4);
    drafts.set('banana', 4.5);
    expect(drafts.value('banana')).toBe(4.5);
    expect(drafts.busy).toBe(true);
    await wait(40);
    expect(sent).toEqual([['banana', 4.5]]);
    expect(drafts.value('banana')).toBeUndefined();
    expect(drafts.busy).toBe(false);
  });

  it('locks only the row being saved, and keeps a tap made meanwhile', async () => {
    let release: () => void = () => {};
    const sent: number[] = [];
    const drafts = new QtyDrafts(
      (_key, value) =>
        new Promise<void>((resolve) => {
          sent.push(value);
          release = resolve;
        }),
      () => {},
      10,
    );
    drafts.set('a', 2);
    await wait(20);
    expect(drafts.isSaving('a')).toBe(true);
    expect(drafts.isSaving('b')).toBe(false);
    drafts.set('a', 3);
    release();
    await wait(1);
    expect(drafts.value('a')).toBe(3);
    await wait(20);
    release();
    await wait(1);
    expect(sent).toEqual([2, 3]);
    expect(drafts.value('a')).toBeUndefined();
  });
});
