import { describe, expect, test } from 'bun:test';
import { guardedClose } from '../components/Sheet';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('guardedClose (CMP-INV-2 / CMP-INT-2)', () => {
  test('a sheet without changes closes at once, without asking', () => {
    let closed = 0;
    let asked = 0;
    guardedClose(false, () => closed++, async () => (asked++, true), { current: false });
    expect(closed).toBe(1);
    expect(asked).toBe(0);
  });

  test('with changes it asks, and keeps the sheet open on "no"', async () => {
    let closed = 0;
    guardedClose(true, () => closed++, async () => false, { current: false });
    await flush();
    expect(closed).toBe(0);
  });

  test('with changes it closes on "discard"', async () => {
    let closed = 0;
    guardedClose(true, () => closed++, async () => true, { current: false });
    await flush();
    expect(closed).toBe(1);
  });

  test('a second Esc while the question is open does not ask twice', async () => {
    let asked = 0;
    let answer: (v: boolean) => void = () => {};
    const confirm = () => {
      asked++;
      return new Promise<boolean>((r) => (answer = r));
    };
    const asking = { current: false };
    let closed = 0;
    guardedClose(true, () => closed++, confirm, asking);
    guardedClose(true, () => closed++, confirm, asking);
    expect(asked).toBe(1);
    answer(true);
    await flush();
    expect(closed).toBe(1);
    expect(asking.current).toBe(false);
  });
});
