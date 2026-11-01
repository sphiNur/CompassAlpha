import { describe, expect, test } from 'bun:test';
import { createTabScrollMemory, restoreScroll } from '../tabScroll';

describe('tab scroll memory (DX-SHL-10)', () => {
  test('each tab remembers its own position; an unseen tab starts at the top', () => {
    const memory = createTabScrollMemory<'order' | 'history'>();
    memory.save('order', 362.4);
    expect(memory.get('order')).toBe(362);
    expect(memory.get('history')).toBe(0);
  });

  test('restoring waits for a page that loads its rows after mounting', () => {
    const el = { scrollTop: 0, scrollHeight: 500, clientHeight: 400 };
    const frames: Array<() => void> = [];
    restoreScroll(el, 362, (cb) => frames.push(cb), () => {});
    // Too short yet: the browser clamps, the helper tries again next frame.
    el.scrollTop = Math.min(el.scrollTop, el.scrollHeight - el.clientHeight);
    expect(frames.length).toBe(1);
    el.scrollHeight = 2000;
    frames.shift()!();
    expect(el.scrollTop).toBe(362);
    expect(frames.length).toBe(0);
  });

  test('stopping (the person scrolled) cancels the retries', () => {
    const el = { scrollTop: 0, scrollHeight: 100, clientHeight: 400 };
    const frames: Array<() => void> = [];
    const stop = restoreScroll(el, 362, (cb) => frames.push(cb), () => {});
    stop();
    el.scrollTop = 10;
    frames.shift()!();
    expect(el.scrollTop).toBe(10);
  });
});
