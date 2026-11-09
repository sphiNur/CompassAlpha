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
  it('leaving the card sends what is still waiting (review ORD-02)', async () => {
    const sent: Array<[string, number]> = [];
    let release: () => void = () => {};
    const drafts = new QtyDrafts(
      (key, value) => {
        sent.push([key, value]);
        return new Promise<void>((r) => {
          release = r;
        });
      },
      () => {},
      1_000,
    );
    drafts.set('banana', 2);
    let settled = false;
    const done = drafts.dispose().then(() => {
      settled = true;
    });
    // Sent at once, not dropped and not after the quiet time.
    expect(sent).toEqual([['banana', 2]]);
    await wait(1);
    // 「通过」 stays held while that write is out.
    expect(settled).toBe(false);
    release();
    await done;
    expect(settled).toBe(true);
  });
});
