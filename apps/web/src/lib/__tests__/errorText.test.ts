import { describe, expect, test } from 'bun:test';
import { errorTextKey } from '../errorText';

describe('errorTextKey', () => {
  test('server i18n keys pass through', () => {
    expect(errorTextKey('order.errors.cannotApprove', 'common.errorUnknown')).toBe(
      'order.errors.cannotApprove',
    );
    expect(errorTextKey('auth.error.x', 'common.errorUnknown')).toBe('auth.error.x');
  });

  test('transport failures map to the network message', () => {
    expect(errorTextKey('Failed to fetch', 'common.errorUnknown')).toBe('common.networkError');
    expect(errorTextKey('Load failed', 'common.errorUnknown')).toBe('common.networkError');
  });

  test('anything else uses the fallback, never the raw text', () => {
    expect(errorTextKey('INTERNAL_SERVER_ERROR', 'common.errorUnknown')).toBe(
      'common.errorUnknown',
    );
    expect(errorTextKey(undefined, 'common.errorUnknown')).toBe('common.errorUnknown');
  });

  test('takes the catalog key out of a zod issue list (CLS-12)', () => {
    const zod = JSON.stringify(
      [{ code: 'custom', message: 'dishes.errors.priceTooLarge', path: ['unitPrice'] }],
      null,
      2,
    );
    expect(errorTextKey(zod, 'common.errorUnknown')).toBe('dishes.errors.priceTooLarge');
    const plain = JSON.stringify([{ code: 'invalid_string', message: 'invalid decimal' }]);
    expect(errorTextKey(plain, 'common.errorUnknown')).toBe('common.errorUnknown');
  });
});
