import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { crashDetails } from '../ErrorBoundary';

/** DX-SHL-16: the trace is copied for the administrator, not shown to staff. */
describe('crash screen', () => {
  test('the copied details carry the message and the top of the stack', () => {
    const error = new Error('boom');
    error.stack = ['Error: boom', ...Array.from({ length: 20 }, (_, i) => `  at f${i}`)].join('\n');
    const text = crashDetails(error);
    expect(text).toContain('boom');
    expect(text).toContain('at f6');
    expect(text).not.toContain('at f7');
  });

  test('the screen renders no <pre> trace', () => {
    const src = readFileSync(new URL('../ErrorBoundary.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain('<pre');
  });
});
