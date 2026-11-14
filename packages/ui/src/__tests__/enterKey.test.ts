import { describe, expect, test } from 'bun:test';
import { isCommitEnter } from '../enterKey';

describe('isCommitEnter', () => {
  test('a plain Enter commits', () => {
    expect(isCommitEnter({ key: 'Enter', keyCode: 13 })).toBe(true);
  });
  test('other keys do not', () => {
    expect(isCommitEnter({ key: 'a', keyCode: 65 })).toBe(false);
  });
  test('an Enter that confirms an IME candidate does not', () => {
    expect(isCommitEnter({ key: 'Enter', keyCode: 13, isComposing: true })).toBe(false);
    expect(isCommitEnter({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: true } })).toBe(
      false,
    );
    // Safari: no isComposing on keydown, keyCode 229 instead.
    expect(isCommitEnter({ key: 'Enter', keyCode: 229 })).toBe(false);
  });
});
