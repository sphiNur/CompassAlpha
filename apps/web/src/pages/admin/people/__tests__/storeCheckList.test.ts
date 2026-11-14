/**
 * Review MWC-12 / MWA-08 (modern-web-guidance: single-line-overflow): why a
 * store cannot be ticked is a muted line under its row, tied to the
 * checkbox, not a `title` tooltip a phone never shows.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoreCheckList } from '../StoreCheckList';

const stores = [
  { id: 'a', name: 'Central' },
  { id: 'b', name: 'North' },
];

const render = () =>
  renderToStaticMarkup(
    createElement(StoreCheckList<(typeof stores)[number]>, {
      stores,
      isChecked: () => false,
      onChange: () => {},
      isDisabled: (st) => st.id === 'b',
      reasonOf: (st) => (st.id === 'b' ? 'Not your store' : undefined),
    }),
  );

describe('StoreCheckList reason line', () => {
  test('the reason is shown and describes that row’s checkbox', () => {
    const html = render();
    expect(html).not.toContain('title=');
    const id = /<p id="([^"]+)"[^>]*>Not your store<\/p>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toContain('aria-describedby');
    expect(inputs[1]).toContain(`aria-describedby="${id}"`);
    expect(inputs[1]).toContain('disabled=""');
  });
});
