import { describe, expect, it } from 'bun:test';
import { createOwnerStack } from '../ownerStack';

describe('createOwnerStack', () => {
  it('publishes the last registrant and restores the previous one on release', () => {
    const published: Array<string | null> = [];
    const stack = createOwnerStack<string>((v) => published.push(v));
    const a = stack.push('page');
    const b = stack.push('sheet');
    expect(stack.top()).toBe('sheet');
    b.release();
    expect(stack.top()).toBe('page');
    a.release();
    expect(stack.top()).toBeNull();
    expect(published).toEqual(['page', 'sheet', 'page', null]);
  });

  it('an update from an owner underneath does not take the slot', () => {
    const stack = createOwnerStack<string>(() => {});
    const a = stack.push('a1');
    stack.push('b');
    a.update('a2');
    expect(stack.top()).toBe('b');
  });

  it('releasing a non-top owner keeps the top and emits nothing', () => {
    let emits = 0;
    const stack = createOwnerStack<string>(() => emits++);
    const a = stack.push('a');
    stack.push('b');
    emits = 0;
    a.release();
    expect(stack.top()).toBe('b');
    expect(emits).toBe(0);
  });

  it('double release is harmless', () => {
    const stack = createOwnerStack<string>(() => {});
    stack.push('a');
    const b = stack.push('b');
    b.release();
    b.release();
    expect(stack.top()).toBe('a');
  });
});
