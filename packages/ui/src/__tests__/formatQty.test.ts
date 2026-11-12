import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QtyControl } from '../components/QtyControl';
import { formatQty } from '../formatQty';

/** Review UI-35: one quantity format for the app and QtyControl. */
describe('formatQty', () => {
  test('comma thousands, up to 3 decimals, no trailing zeros', () => {
    expect(formatQty(1000)).toBe('1,000');
    expect(formatQty('1200.000')).toBe('1,200');
    expect(formatQty('0.050')).toBe('0.05');
    expect(formatQty(8.949)).toBe('8.949');
    expect(formatQty(2.5)).toBe('2.5');
    expect(formatQty(0)).toBe('0');
  });

  test('empty is empty, and what is not a number comes back as it was', () => {
    expect(formatQty(null)).toBe('');
    expect(formatQty(undefined)).toBe('');
    expect(formatQty('')).toBe('');
    expect(formatQty('n/a')).toBe('n/a');
  });

  test('QtyControl shows the value the way the order summary does', () => {
    const html = renderToStaticMarkup(
      createElement(QtyControl, { value: 1000, step: 100, unit: 'kg', onChange: () => {} }),
    );
    expect(html).toContain('1,000');
    expect(html).not.toMatch(/>1000</);
  });
});
