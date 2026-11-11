import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FieldError } from '../components/FieldError';
import { FieldLabel } from '../components/Rows';

/** Review CONF-21: one field label and one field error for every form. */
describe('FieldLabel / FieldError', () => {
  test('a label for a control it does not wrap is a <label for>', () => {
    expect(
      renderToStaticMarkup(createElement(FieldLabel, { htmlFor: 'qty', children: 'Received' })),
    ).toMatch(/^<label for="qty" class="[^"]*">Received<\/label>$/);
    expect(renderToStaticMarkup(createElement(FieldLabel, { children: 'Received' }))).toMatch(
      /^<span class="[^"]*">Received<\/span>$/,
    );
  });

  test('an error is an alert in the danger colour, and its text is the message alone', () => {
    const html = renderToStaticMarkup(
      createElement(FieldError, { id: 'qty-error', children: 'Enter a quantity' }),
    );
    expect(html).toMatch(
      /^<span id="qty-error" role="alert" class="[^"]*text-\[var\(--c-danger\)\]/,
    );
    expect(html).toContain('<svg aria-hidden="true"');
    // The sign is drawn, so a screen reader or a test reads the message only.
    expect(html.replace(/<[^>]+>/g, '')).toBe('Enter a quantity');
  });

  test('a call site can drop the top margin', () => {
    const html = renderToStaticMarkup(
      createElement(FieldError, { className: 'mt-0', children: 'x' }),
    );
    const spanClass = /^<span role="alert" class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(spanClass.split(' ')).toContain('mt-0');
    expect(spanClass.split(' ')).not.toContain('mt-1');
  });
});
