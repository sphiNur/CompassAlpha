import { describe, expect, it } from 'bun:test';
import { focusFirst } from '../focusFirst';

/** A document where each selector finds one named element, in this order. */
function page(found: Record<string, string>) {
  const focused: string[] = [];
  const root = {
    querySelector: (selector: string) =>
      selector in found ? { focus: () => void focused.push(found[selector]!) } : null,
  } as unknown as Pick<ParentNode, 'querySelector'>;
  return { root, focused };
}

describe('focusFirst (COREWEB1-25)', () => {
  const current = '[data-testid="primary-nav"] [aria-current="page"]';
  const anyTab = '[data-testid="primary-nav"] button';

  it('takes the current tab over the first one', () => {
    const { root, focused } = page({ [current]: 'history tab', [anyTab]: 'order tab' });
    expect(focusFirst([current, anyTab], root)).toBe(true);
    expect(focused).toEqual(['history tab']);
  });

  it('falls back to the next selector, and says when nothing was found', () => {
    const fallback = page({ [anyTab]: 'order tab' });
    expect(focusFirst([current, anyTab], fallback.root)).toBe(true);
    expect(fallback.focused).toEqual(['order tab']);
    const none = page({});
    expect(focusFirst([current, anyTab], none.root)).toBe(false);
    expect(none.focused).toEqual([]);
  });
});
