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
    expect(isOpen(null, 'a')).toBe(false);
    expect(isOpen(null, 'b')).toBe(false);
  });

  it('opens only the selected group', () => {
    expect(isOpen('a', 'a')).toBe(true);
    expect(isOpen('a', 'b')).toBe(false);
    expect(isOpen('a', 'c')).toBe(false);
  });

  // No lone-group exception on purpose: a forced-open group made the
  // toggle report a state it would not change on activation. See the
  // note on isOpen.
  it('collapses a lone group like any other', () => {
    expect(isOpen(null, 'only')).toBe(false);
    expect(isOpen('only', 'only')).toBe(true);
  });
});
