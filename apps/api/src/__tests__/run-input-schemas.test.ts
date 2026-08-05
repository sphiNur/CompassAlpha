/**
 * Edge-schema contract for the reason-carrying run commands.
 *
 * These exist because the tRPC boundary and the domain layer silently
 * disagreed about `run.cancel` for months: the domain has allowed an
 * empty reason since M1.7 and the FE deliberately sends one
 * (requireReason:false), but `run.cancel` was wired to the SHARED
 * `RunReasonOnlyInputSchema` whose `.min(1)` rejected it. Every
 * no-reason cancel died as BAD_REQUEST behind a generic error toast,
 * and no test anywhere covered the boundary.
 *
 * The asymmetry below is the whole point: cancel is permissive, the
 * other three are strict. If someone later "simplifies" these back into
 * one schema, exactly one of these two describes will fail.
 *
 * No Postgres needed — pure zod, runs in the fast CI unit job.
 */
import { describe, expect, test } from 'bun:test';
import {
  RunCancelInputSchema,
  RunHistoryInputSchema,
  RunReasonOnlyInputSchema,
} from '@compass/contracts';

const RUN_ID = '11111111-2222-4333-8444-555555555555';

describe('RunCancelInputSchema (permissive — reason optional)', () => {
  test('accepts an omitted reason and defaults it to empty', () => {
    const parsed = RunCancelInputSchema.parse({ runId: RUN_ID });
    expect(parsed.reason).toBe('');
  });

  test('accepts an explicit empty string — the exact payload the FE sends', () => {
    const parsed = RunCancelInputSchema.parse({ runId: RUN_ID, reason: '' });
    expect(parsed.reason).toBe('');
  });

  test('trims a whitespace-only reason to empty rather than rejecting', () => {
    const parsed = RunCancelInputSchema.parse({ runId: RUN_ID, reason: '   ' });
    expect(parsed.reason).toBe('');
  });

  test('keeps a real reason, trimmed', () => {
    const parsed = RunCancelInputSchema.parse({ runId: RUN_ID, reason: '  市场关门了  ' });
    expect(parsed.reason).toBe('市场关门了');
  });

  test('still rejects an over-long reason', () => {
    expect(() => RunCancelInputSchema.parse({ runId: RUN_ID, reason: 'x'.repeat(501) })).toThrow();
  });

  test('still rejects a malformed runId', () => {
    expect(() => RunCancelInputSchema.parse({ runId: 'not-a-uuid', reason: '' })).toThrow();
  });
});

describe('RunReasonOnlyInputSchema (strict — reopen / undoStartPurchase / undoStartDelivery)', () => {
  // These three re-assert the requirement in the domain layer too, so
  // relaxing this schema would only move the rejection from a clean
  // 400 into a domain throw. It must stay strict.
  test('rejects an empty reason', () => {
    expect(() => RunReasonOnlyInputSchema.parse({ runId: RUN_ID, reason: '' })).toThrow();
  });

  test('rejects an omitted reason', () => {
    expect(() => RunReasonOnlyInputSchema.parse({ runId: RUN_ID })).toThrow();
  });

  test('accepts a real reason', () => {
    const parsed = RunReasonOnlyInputSchema.parse({ runId: RUN_ID, reason: 'wrong day' });
    expect(parsed.reason).toBe('wrong day');
  });
});

describe('RunHistoryInputSchema', () => {
  test('applies the mobile history page defaults', () => {
    expect(RunHistoryInputSchema.parse({})).toEqual({
      sort: 'newest',
      page: 1,
      pageSize: 20,
    });
  });

  test('trims search and accepts combined filters', () => {
    const parsed = RunHistoryInputSchema.parse({
      search: '  beef stall  ',
      storeId: RUN_ID,
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      payment: 'mixed',
      sort: 'oldest',
      page: 2,
      pageSize: 50,
    });
    expect(parsed.search).toBe('beef stall');
    expect(parsed.page).toBe(2);
  });

  test('rejects a reversed date range and oversized pages', () => {
    expect(() =>
      RunHistoryInputSchema.parse({ dateFrom: '2026-08-02', dateTo: '2026-08-01' }),
    ).toThrow();
    expect(() => RunHistoryInputSchema.parse({ pageSize: 51 })).toThrow();
  });
});
