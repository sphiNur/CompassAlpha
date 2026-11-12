import { describe, expect, test } from 'bun:test';
import { isLockedStatus, otherRejectedBatch } from '../batchStatus';

// Review ORD-10 (2026-11, step 2): what the order page's hooks and views
// ask of a batch's status, said once.
describe('isLockedStatus', () => {
  test('a sent batch is no longer its owner to edit', () => {
    for (const status of ['submitted', 'approved', 'in_run', 'archived']) {
      expect(isLockedStatus(status)).toBe(true);
    }
  });

  test('a draft and a rejected batch are edited in place; no batch is not locked', () => {
    for (const status of ['draft', 'rejected', null, undefined]) {
      expect(isLockedStatus(status)).toBe(false);
    }
  });
});

describe('otherRejectedBatch', () => {
  const batches = [
    { id: 'a', status: 'approved' },
    { id: 'b', status: 'rejected' },
    { id: 'c', status: 'draft' },
  ];

  test('a rejected batch other than the one shown', () => {
    expect(otherRejectedBatch(batches, 'c')?.id).toBe('b');
    expect(otherRejectedBatch(batches, undefined)?.id).toBe('b');
  });

  test('not the batch on screen itself', () => {
    expect(otherRejectedBatch(batches, 'b')).toBeNull();
  });

  test('none rejected, or nothing loaded yet', () => {
    expect(otherRejectedBatch([{ id: 'a', status: 'submitted' }], 'x')).toBeNull();
    expect(otherRejectedBatch(undefined, 'x')).toBeNull();
  });
});
