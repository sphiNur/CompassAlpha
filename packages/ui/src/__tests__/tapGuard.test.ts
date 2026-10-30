import { describe, expect, it } from 'bun:test';

import { REPEAT_TAP_MS } from '../components/Button';
import { createTapGuard } from '../useTapGuard';

// DLV-4 / BUY-12 (2026-10-30): a double tap on a confirm button sent two
// requests — success and conflict toasts together. Button (for every
// button that carries `loading`) and ConfirmSheet both decide with this.
describe('createTapGuard', () => {
  it('lets the first tap through and drops a quick second one', () => {
    const g = createTapGuard(700);
    expect(g.allow('', 1_000)).toBe(true);
    expect(g.allow('', 1_120)).toBe(false); // a double tap
    expect(g.allow('', 1_690)).toBe(false);
  });

  it('allows the same action again once the window has passed', () => {
    const g = createTapGuard(700);
    expect(g.allow('', 1_000)).toBe(true);
    expect(g.allow('', 1_700)).toBe(true);
  });

  it('measures the window from the last ALLOWED tap, not the dropped ones', () => {
    const g = createTapGuard(700);
    g.allow('', 0);
    g.allow('', 600); // dropped
    expect(g.allow('', 700)).toBe(true);
  });

  it('does not treat a different action as a repeat', () => {
    const g = createTapGuard(700);
    expect(g.allow('开始配送', 0)).toBe(true);
    expect(g.allow('结束采购', 100)).toBe(true);
    expect(g.allow('结束采购', 200)).toBe(false);
  });

  it('the very first tap is never dropped, whatever the clock says', () => {
    expect(createTapGuard(700).allow('', 0)).toBe(true);
  });

  it('the Button window is long enough for a double tap', () => {
    expect(REPEAT_TAP_MS).toBeGreaterThanOrEqual(500);
  });
});
