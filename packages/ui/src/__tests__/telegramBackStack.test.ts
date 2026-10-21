import { describe, expect, test } from 'bun:test';
import { createBackHandlerStack, type BackButtonLike } from '../telegramBackStack';

function fakeButton() {
  const listeners = new Set<() => void>();
  const btn: BackButtonLike & { visible: boolean; tap: () => void; listenerCount: () => number } = {
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    onClick(cb) {
      listeners.add(cb);
    },
    offClick(cb) {
      listeners.delete(cb);
    },
    tap() {
      listeners.forEach((l) => l());
    },
    listenerCount: () => listeners.size,
  };
  return btn;
}

describe('createBackHandlerStack', () => {
  test('shows while any handler is registered and hides when empty', () => {
    const btn = fakeButton();
    const stack = createBackHandlerStack(() => btn);
    const release = stack.push(() => {});
    expect(btn.visible).toBe(true);
    release();
    expect(btn.visible).toBe(false);
    expect(btn.listenerCount()).toBe(0);
  });

  test('a tap calls only the last registrant (top sheet), with one SDK listener', () => {
    const btn = fakeButton();
    const stack = createBackHandlerStack(() => btn);
    const calls: string[] = [];
    stack.push(() => calls.push('section'));
    const releaseSheet = stack.push(() => calls.push('sheet'));
    expect(btn.listenerCount()).toBe(1);
    btn.tap();
    expect(calls).toEqual(['sheet']);
    releaseSheet();
    btn.tap();
    expect(calls).toEqual(['sheet', 'section']);
    expect(btn.visible).toBe(true);
  });

  test('out-of-order release keeps the button for the remaining owner', () => {
    const btn = fakeButton();
    const stack = createBackHandlerStack(() => btn);
    const calls: string[] = [];
    const releaseA = stack.push(() => calls.push('a'));
    stack.push(() => calls.push('b'));
    releaseA();
    expect(btn.visible).toBe(true);
    btn.tap();
    expect(calls).toEqual(['b']);
  });

  test('double release is a no-op', () => {
    const btn = fakeButton();
    const stack = createBackHandlerStack(() => btn);
    stack.push(() => {});
    const release = stack.push(() => {});
    release();
    release();
    expect(stack.size()).toBe(1);
  });

  test('no SDK button: bookkeeping still works without throwing', () => {
    const stack = createBackHandlerStack(() => null);
    const release = stack.push(() => {});
    expect(stack.size()).toBe(1);
    release();
    expect(stack.size()).toBe(0);
  });
});
