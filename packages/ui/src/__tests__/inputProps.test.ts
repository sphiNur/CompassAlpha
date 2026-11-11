import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { Input } from '../components/Input';

/**
 * Review UI-12 / CONF-22: a number field takes no min / max / step (the
 * browser checks none of them on the text field it really is), and only a
 * number field takes `formatError`. `pnpm type-check` compiles this file
 * (tsconfig.test.json), so each `@ts-expect-error` below must stay an error.
 */
describe('Input props by type', () => {
  test('the props a field may take compile', () => {
    const allowed = [
      createElement(Input, { type: 'number', formatError: 'none', invalid: true }),
      createElement(Input, { type: 'date', min: '2026-01-01', max: '2026-12-31' }),
      createElement(Input, { maxLength: 40 }),
    ];
    expect(allowed).toHaveLength(3);
  });

  test('a number field refuses a range, and a text field formatError', () => {
    const refused = [
      // @ts-expect-error a number field takes no min
      createElement(Input, { type: 'number', min: 0 }),
      // @ts-expect-error a number field takes no max
      createElement(Input, { type: 'number', max: '10' }),
      // @ts-expect-error a number field takes no step
      createElement(Input, { type: 'number', step: 0.5 }),
      // @ts-expect-error formatError is for number fields only
      createElement(Input, { formatError: 'none' }),
    ];
    expect(refused).toHaveLength(4);
  });
});
