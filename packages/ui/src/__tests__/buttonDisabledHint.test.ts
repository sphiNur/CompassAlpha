import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, buttonHint } from '../components/Button';

/**
 * UX-05: a disabled Save says what is missing, in a muted line the button
 * points at with aria-describedby.
 */
describe('Button disabledHint', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(Button, props, 'Save'));

  test('a disabled button is described by its hint', () => {
    const html = render({ block: true, disabled: true, disabledHint: 'Enter a name.' });
    const id = /id="([^"]+)"[^>]*data-testid="button-disabled-hint"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain('>Enter a name.</span>');
    // Announced politely when it appears or changes.
    expect(html).toMatch(/<span[^>]*role="status"[^>]*aria-live="polite"[^>]*>Enter a name\.</);
    expect(html).toMatch(new RegExp(`<button[^>]*aria-describedby="${id}"`));
    // A footer's block button has the line above it.
    expect(html.indexOf('button-disabled-hint')).toBeLessThan(html.indexOf('<button'));
  });

  test('an inline button has it below, so a row of buttons stays level', () => {
    const html = render({ disabled: true, disabledHint: 'Nothing has changed yet.' });
    const id = /id="([^"]+)"[^>]*data-testid="button-disabled-hint"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<button[^>]*aria-describedby="${id}"`));
    expect(html.indexOf('button-disabled-hint')).toBeGreaterThan(html.indexOf('<button'));
  });

  test('keeps a describedby the caller set', () => {
    const html = render({ disabled: true, disabledHint: 'x', 'aria-describedby': 'other' });
    const id = /id="([^"]+)"[^>]*data-testid="button-disabled-hint"/.exec(html)?.[1];
    expect(html).toContain(`aria-describedby="other ${id}"`);
  });

  test('no hint while enabled, loading or empty — but the wrapper stays', () => {
    for (const props of [
      { disabled: false, disabledHint: 'x' },
      { disabled: true, loading: true, disabledHint: 'x' },
      { disabled: true, disabledHint: '  ' },
      { disabled: true, disabledHint: undefined },
    ]) {
      const html = render(props);
      expect(html).not.toContain('button-disabled-hint');
      expect(html).not.toContain('aria-describedby');
      expect(html.startsWith('<span')).toBe(true);
    }
  });

  test('without the prop the button is not wrapped', () => {
    expect(render({ disabled: true }).startsWith('<button')).toBe(true);
  });

  test('buttonHint', () => {
    expect(buttonHint(true, false, ' Pick a store. ')).toBe('Pick a store.');
    expect(buttonHint(false, false, 'x')).toBeUndefined();
    expect(buttonHint(true, true, 'x')).toBeUndefined();
    expect(buttonHint(true, undefined, '')).toBeUndefined();
  });
});
