import { describe, expect, test } from 'bun:test';
import { showFieldError, withTouched } from '../fieldErrors';

describe('showFieldError (DX-VIS-15)', () => {
  test('an empty new field is not red before anything happened', () => {
    expect(showFieldError(true, new Set(), 'e1:amount', false)).toBe(false);
  });
  test('it is red after the person left it, or after a save was tried', () => {
    expect(showFieldError(true, new Set(['e1:amount']), 'e1:amount', false)).toBe(true);
    expect(showFieldError(true, new Set(), 'e1:amount', true)).toBe(true);
  });
  test('a valid field is never red', () => {
    expect(showFieldError(false, new Set(['e1:amount']), 'e1:amount', true)).toBe(false);
  });
  test('withTouched keeps the same set when nothing changes', () => {
    const a = new Set(['x']);
    expect(withTouched(a, 'x')).toBe(a);
    expect([...withTouched(a, 'y')]).toEqual(['x', 'y']);
  });
});
