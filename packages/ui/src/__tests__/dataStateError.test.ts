import { describe, expect, test } from 'bun:test';
import { resolveDataStateError } from '../components/dataStateError';

const passthrough = (m: string | undefined) => m;

describe('resolveDataStateError', () => {
  test('uses the host translation of the message', () => {
    const t = (m: string | undefined) => (m === 'order.errors.notFound' ? 'Order not found' : m);
    expect(resolveDataStateError({ message: 'order.errors.notFound' }, t, 'Unknown')).toBe(
      'Order not found',
    );
  });

  test('falls back when there is no message', () => {
    expect(resolveDataStateError(null, passthrough, 'Unknown')).toBe('Unknown');
    expect(resolveDataStateError({ message: '   ' }, passthrough, 'Unknown')).toBe('Unknown');
  });

  test('falls back when translation is blank or throws', () => {
    expect(resolveDataStateError({ message: 'x' }, () => '', 'Unknown')).toBe('Unknown');
    expect(
      resolveDataStateError(
        { message: 'x' },
        () => {
          throw new Error('boom');
        },
        'Unknown',
      ),
    ).toBe('Unknown');
  });

  test('default (passthrough) keeps the old behaviour', () => {
    expect(resolveDataStateError({ message: 'raw' }, passthrough, 'Unknown')).toBe('raw');
  });
});
