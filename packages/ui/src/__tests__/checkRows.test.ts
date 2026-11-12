import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Checkbox } from '../components/Checkbox';
import { Switch } from '../components/Switch';

const labelClass = (html: string) => /<label[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';

/** Review UI-36: a labelled Checkbox or Switch row is a 44 px tap target. */
describe('Checkbox and Switch rows', () => {
  test('a one-line Checkbox row is 44 px tall, its box and text centred', () => {
    const cls = labelClass(
      renderToStaticMarkup(createElement(Checkbox, { label: 'Smoke Store', onChange: () => {} })),
    );
    expect(cls).toContain('min-h-[var(--control-h)]');
    expect(cls).toContain('items-center');
  });

  test('a Checkbox row with a hint keeps its box on the label line', () => {
    const cls = labelClass(
      renderToStaticMarkup(
        createElement(Checkbox, { label: 'Members too', hint: 'Copies roles', onChange: () => {} }),
      ),
    );
    expect(cls).toContain('min-h-[var(--control-h)]');
    expect(cls).toContain('items-start');
    expect(cls).not.toContain('items-center');
  });

  test('a caller can still set the row (the run picker centres its two-line rows)', () => {
    const cls = labelClass(
      renderToStaticMarkup(
        createElement(Checkbox, {
          label: 'Smoke Store',
          hint: 'Batch 1',
          className: 'min-h-11 items-center',
          onChange: () => {},
        }),
      ),
    );
    expect(cls).toContain('min-h-11 items-center');
    expect(cls).not.toContain('min-h-[var(--control-h)]');
    expect(cls).not.toContain('items-start');
  });

  test('a Switch row is 44 px tall', () => {
    const cls = labelClass(
      renderToStaticMarkup(createElement(Switch, { label: 'Active', onChange: () => {} })),
    );
    expect(cls).toContain('min-h-[var(--control-h)]');
  });
});
