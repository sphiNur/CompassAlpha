/**
 * Pins the single-open accordion contract the user asked for:
 * collapsed by default, one open at a time, tapping the open one closes.
 */
import { describe, it, expect } from 'bun:test';
import { toggleOpen, pruneOpen, isOpen } from '../accordion';

describe('toggleOpen', () => {
  it('opens a group when nothing is open', () => {
    expect(toggleOpen(null, 'a')).toBe('a');
  });

  it('closes the group that is already open', () => {
    expect(toggleOpen('a', 'a')).toBeNull();
  });

  it('switches directly from one group to another — never two at once', () => {
    expect(toggleOpen('a', 'b')).toBe('b');
  });
});

describe('pruneOpen', () => {
  it('keeps an open key that still exists', () => {
    expect(pruneOpen('a', ['a', 'b'])).toBe('a');
  });

  it('drops an open key whose group disappeared', () => {
    // e.g. the SKU that made this stall's bucket exist was reassigned.
    expect(pruneOpen('a', ['b', 'c'])).toBeNull();
  });

  it('is a no-op when nothing is open', () => {
    expect(pruneOpen(null, ['a'])).toBeNull();
    expect(pruneOpen(null, [])).toBeNull();
  });

  it('drops everything when the group set empties', () => {
    expect(pruneOpen('a', [])).toBeNull();
  });
});

describe('isOpen', () => {
  it('collapses every group by default', () => {
    expect(isOpen(null, 'a', 3)).toBe(false);
    expect(isOpen(null, 'b', 3)).toBe(false);
  });

  it('opens only the selected group', () => {
    expect(isOpen('a', 'a', 3)).toBe(true);
    expect(isOpen('a', 'b', 3)).toBe(false);
    expect(isOpen('a', 'c', 3)).toBe(false);
  });

  it('keeps a lone group open — collapsing it would hide the whole screen', () => {
    expect(isOpen(null, 'only', 1)).toBe(true);
    expect(isOpen('other', 'only', 1)).toBe(true);
  });

  it('treats an empty group set as trivially open', () => {
    expect(isOpen(null, 'x', 0)).toBe(true);
  });

  it('starts collapsing again as soon as there are two groups', () => {
    expect(isOpen(null, 'a', 2)).toBe(false);
  });
});
