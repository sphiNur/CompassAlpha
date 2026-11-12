import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ListRow, SectionRow } from '../components/Rows';

/**
 * Review UI-23: a row group (rowGroupClass) is overflow-hidden, so a focus
 * outline drawn outside a row button lost its sides. The tappable rows draw
 * it inside themselves.
 */
describe('row focus outline', () => {
  test('SectionRow and a tappable ListRow keep their focus outline inside', () => {
    const rows = [
      createElement(SectionRow, { label: 'Stores', onClick: () => {} }),
      createElement(ListRow, { label: 'Smoke Store', onClick: () => {} }),
    ];
    for (const row of rows) {
      expect(renderToStaticMarkup(row)).toMatch(
        /^(<li>)?<button[^>]*class="[^"]*focus-visible:outline-offset-\[-2px\]/,
      );
    }
  });
});
