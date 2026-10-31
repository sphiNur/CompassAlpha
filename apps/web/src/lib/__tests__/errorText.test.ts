import { beforeAll, describe, expect, test } from 'bun:test';
import { createI18n, loadCatalog } from '@compass/i18n';
import {
  errorTextKey,
  errorTextOf,
  errorVars,
  isServerSideFailure,
  networkFailureKey,
} from '../errorText';

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

// CMP-FE-1 / CMP-COPY-2 (2026-10-31): the server's `data.context` was
// dropped, so every sentence with a placeholder printed a blank.
describe('errorTextOf: placeholders from the server', () => {
  beforeAll(async () => {
    await Promise.all((['zh', 'ru', 'uz'] as const).map((l) => loadCatalog(l)));
  });
  /** What tRPC hands a mutation's onError for a DomainError. */
  const domainError = (key: string, context: Record<string, unknown>) => ({
    message: key,
    data: { code: 'BAD_REQUEST', domainCode: 'VALIDATION', i18nKey: key, context },
  });
  const say = (err: unknown, locale: 'zh' | 'en' | 'ru' | 'uz' = 'zh') => {
    const { key, vars } = errorTextOf(err, 'common.errorUnknown');
    return createI18n(locale).t(key as Parameters<ReturnType<typeof createI18n>['t']>[0], vars);
  };

  test('every server error key with a placeholder gets its value', () => {
    expect(say(domainError('order.errors.qtyNotMultipleOfStep', { step: '0.500' }))).toBe(
      '数量必须是 0.5 的倍数',
    );
    expect(say(domainError('run.errors.storeItemsUnchecked', { n: 3 }))).toBe(
      '还有 3 项待核对，核对完才能确认收货',
    );
    expect(say(domainError('run.errors.receivedQtyExceedsSplit', { max: '12.000' }))).toBe(
      '实收数量不能超过 12',
    );
    expect(say(domainError('run.errors.receivedQtyNotShort', { max: '2.5' }))).toContain('2.5');
    expect(say(domainError('settlement.errors.dateTooOld', { days: 90 }), 'en')).toContain(
      'at most 90 days back',
    );
    expect(say(domainError('order.errors.qtyNotMultipleOfStep', { step: '0.25' }), 'ru')).toBe(
      'Количество должно быть кратно 0.25',
    );
  });

  test('data.i18nKey names the sentence when the message is something else', () => {
    const err = {
      message: 'Quantity off step',
      data: { i18nKey: 'order.errors.qtyNotMultipleOfStep', context: { step: '1' } },
    };
    expect(errorTextOf(err, 'common.errorUnknown')).toEqual({
      key: 'order.errors.qtyNotMultipleOfStep',
      vars: { step: '1' },
    });
  });

  test('a schema refusal keeps the caller fallback, not the generic validation key', () => {
    const err = {
      message: JSON.stringify([{ code: 'invalid_string', message: 'invalid decimal' }]),
      data: { i18nKey: 'common.errors.validation' },
    };
    expect(errorTextOf(err, 'order.toast.saveFailed').key).toBe('order.toast.saveFailed');
  });

  test('only plain values are used; transport failures still map as before', () => {
    expect(errorVars({ data: { context: { n: 2, skuId: 'a', nested: { x: 1 }, list: [1] } } })).toEqual({
      n: 2,
      skuId: 'a',
    });
    expect(errorVars({ data: { context: null } })).toEqual({});
    expect(errorVars(null)).toEqual({});
    expect(errorTextOf(new Error('Failed to fetch'), 'common.errorUnknown')).toEqual({
      key: 'common.networkError',
      vars: {},
    });
  });
});
