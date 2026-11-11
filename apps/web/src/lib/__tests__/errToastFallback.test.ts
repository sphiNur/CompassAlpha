/**
 * DX-COPY-8 (2026-11-01): a failed write tells the user what to do next.
 * `common.error` ("Something went wrong") was the fallback of 99 calls;
 * mutations now fall back to `common.errors.actionFailed` or their own
 * failure sentence, and the bare title stays for load banners that carry
 * a Retry button.
 *
 * Review TEST3-06 (2026-11-10): this test read every source file with a
 * regular expression, which a line break or a renamed variable got past.
 * The fallback's type now refuses the bare title in any spelling (tsc
 * checks this file through tsconfig.test.json), and an ESLint rule in
 * eslint.shared.mjs catches `toast.error(i18n.t('common.error'))`
 * written by hand.
 */
import { describe, expect, it } from 'bun:test';
import type { WriteFallbackKey } from '../errToast';

describe('error toasts', () => {
  it('never fall back to the bare "Something went wrong"', () => {
    const sentence: WriteFallbackKey = 'common.errors.actionFailed';
    // @ts-expect-error The bare title says neither why nor what to do (DX-COPY-8).
    const bare: WriteFallbackKey = 'common.error';
    const keys: string[] = [sentence, bare];
    expect(keys).toEqual(['common.errors.actionFailed', 'common.error']);
  });
});
