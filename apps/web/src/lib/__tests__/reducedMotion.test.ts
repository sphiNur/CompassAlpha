import { describe, expect, test } from 'bun:test';
import { scrollBehavior } from '../reducedMotion';

describe('scrollBehavior (A11Y-8)', () => {
  test('jumps when the system asks for reduced motion', () => {
    expect(scrollBehavior((q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }))).toBe(
      'auto',
    );
  });

  test('smooth otherwise, and without matchMedia', () => {
    expect(scrollBehavior(() => ({ matches: false }))).toBe('smooth');
    expect(scrollBehavior(undefined)).toBe('smooth');
  });
});
