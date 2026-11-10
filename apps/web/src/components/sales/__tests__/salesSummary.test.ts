import { describe, expect, test } from 'bun:test';
import { normalizeVoidReason, salesListView } from '../salesSummary';

describe('normalizeVoidReason', () => {
  test('trims and accepts 1..300 chars', () => {
    expect(normalizeVoidReason('  wrong dish ')).toBe('wrong dish');
    expect(normalizeVoidReason('x'.repeat(300))).toHaveLength(300);
  });
  test('rejects blank and over-long', () => {
    expect(normalizeVoidReason('   ')).toBeNull();
    expect(normalizeVoidReason('x'.repeat(301))).toBeNull();
  });
});

describe('salesListView (2026-10-21 FE-01)', () => {
  test('loading first', () => {
    expect(salesListView({ isLoading: true, isError: false, rowCount: 0 })).toBe('loading');
  });
  test('an error is never shown as empty', () => {
    expect(salesListView({ isLoading: false, isError: true, rowCount: 0 })).toBe('error');
  });
  test('an error wins over stale rows', () => {
    expect(salesListView({ isLoading: false, isError: true, rowCount: 3 })).toBe('error');
  });
  // CLS-6 (2026-10-31): offline with nothing saved is not "no sales yet".
  test('waiting offline with no rows is offline, not empty', () => {
    expect(salesListView({ isLoading: false, isError: false, rowCount: 0, waitingOffline: true })).toBe(
      'offline',
    );
  });
  test('empty vs list', () => {
    expect(salesListView({ isLoading: false, isError: false, rowCount: 0 })).toBe('empty');
    expect(salesListView({ isLoading: false, isError: false, rowCount: 2 })).toBe('list');
  });
  // EMP-4 (2026-10-31): one empty state, the one that says why.
  test('no list empty state while the record card says recording is blocked', () => {
    expect(
      salesListView({ isLoading: false, isError: false, rowCount: 0, recordingBlocked: true }),
    ).toBe('none');
    expect(
      salesListView({ isLoading: false, isError: false, rowCount: 2, recordingBlocked: true }),
    ).toBe('list');
    expect(
      salesListView({ isLoading: false, isError: true, rowCount: 0, recordingBlocked: true }),
    ).toBe('error');
  });
});
