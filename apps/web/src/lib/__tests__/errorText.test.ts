import { describe, expect, test } from 'bun:test';
import { errorTextKey, isServerSideFailure, networkFailureKey } from '../errorText';

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

// R2-AUTH-3 (2026-10-31): the server answering with an error is not the
// user's connection.
describe('server-side failures', () => {
  test('a gateway page or a refresh 5xx says the server had a problem', () => {
    expect(isServerSideFailure('Failed to fetch (gateway 502)')).toBe(true);
    expect(isServerSideFailure('Failed to fetch (session refresh did not complete: server 500)')).toBe(true);
    expect(errorTextKey('Failed to fetch (gateway 503)', 'common.errorUnknown')).toBe('common.errors.internal');
    expect(
      errorTextKey('Failed to fetch (session refresh did not complete: server 500)', 'common.errorUnknown'),
    ).toBe('common.errors.internal');
  });

  test('no answer at all is still a network error', () => {
    expect(isServerSideFailure('Failed to fetch (session refresh did not complete)')).toBe(false);
    expect(errorTextKey('Failed to fetch (timed out)', 'common.errorUnknown')).toBe('common.networkError');
  });
});

// R2-CLS-1 (2026-10-31): "not saved" only when the device knows it never sent it.
describe('networkFailureKey', () => {
  test('offline: not saved', () => {
    expect(networkFailureKey(false, false)).toBe('common.offlineNotSaved');
    expect(networkFailureKey(false, true)).toBe('common.offlineNotSaved');
  });
  test('online but no answer: unknown, and safe to retry only with a stable key', () => {
    expect(networkFailureKey(true, false)).toBe('common.maybeSaved');
    expect(networkFailureKey(true, true)).toBe('common.maybeSavedRetrySafe');
  });
});
