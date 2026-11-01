import { describe, expect, test } from 'bun:test';
import { pickReturnFocus, type FocusableLike } from '../sheetFocus';
import { confirmCancelPolicy } from '../components/ConfirmSheet';

/** DX-IX-2 / DX-IX-3 / DX-IX-6: where focus goes around sheets. */
function el(opts: Partial<{ connected: boolean; disabled: boolean; inSheet: boolean; hidden: boolean }> = {}) {
  const o = { connected: true, disabled: false, inSheet: false, hidden: false, ...opts };
  const node: FocusableLike & { focused: number } = {
    focused: 0,
    isConnected: o.connected,
    focus() {
      node.focused++;
    },
    hasAttribute: (name: string) => name === 'disabled' && o.disabled,
    closest: (selector: string) =>
      (selector.includes('data-sheet-content') && o.inSheet) ||
      (selector.includes('aria-hidden') && o.hidden)
        ? {}
        : null,
  };
  return node;
}
const body = {};

describe('pickReturnFocus', () => {
  test('back to the button that opened the sheet', () => {
    const opener = el();
    const fallback = el();
    expect(pickReturnFocus(opener, null, body, fallback)).toBe(opener);
  });

  test('to the page fallback when the opener is gone (the action removed it)', () => {
    const fallback = el();
    expect(pickReturnFocus(el({ connected: false }), body as FocusableLike, body, fallback)).toBe(fallback);
    expect(pickReturnFocus(el({ disabled: true }), null, body, fallback)).toBe(fallback);
    expect(pickReturnFocus(null, null, body, fallback)).toBe(fallback);
  });

  test('a sheet opened with focus on <body> also returns to the fallback', () => {
    const fallback = el();
    expect(pickReturnFocus(body as FocusableLike, null, body, fallback)).toBe(fallback);
  });

  test('leaves focus alone when it is already in another open sheet', () => {
    expect(pickReturnFocus(el(), el({ inSheet: true }), body, el())).toBeNull();
  });

  test('never into a hidden part of the page', () => {
    const fallback = el();
    expect(pickReturnFocus(el({ hidden: true }), null, body, fallback)).toBe(fallback);
  });
});

describe('confirmCancelPolicy (DX-IX-6)', () => {
  test('a reversible confirm keeps its one button', () => {
    expect(confirmCancelPolicy({})).toEqual({ showCancel: false, focusCancel: false });
  });
  test('destructive and locking confirms show Cancel and start on it', () => {
    expect(confirmCancelPolicy({ danger: true })).toEqual({ showCancel: true, focusCancel: true });
    expect(confirmCancelPolicy({ irreversible: true })).toEqual({ showCancel: true, focusCancel: true });
  });
  test('a caller can ask for it (the price check), which also shows Cancel', () => {
    expect(confirmCancelPolicy({ focusCancel: true })).toEqual({ showCancel: true, focusCancel: true });
  });
  test('with a required reason the field takes focus; Cancel is still shown', () => {
    expect(confirmCancelPolicy({ danger: true, requireReason: true })).toEqual({
      showCancel: true,
      focusCancel: false,
    });
  });
});
