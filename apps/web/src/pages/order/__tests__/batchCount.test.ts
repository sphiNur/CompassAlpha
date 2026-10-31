import { describe, expect, test } from 'bun:test';
import { sentBatchCount } from '../batchCount';

// Design review U5 (2026-10-31): the draft being filled in is not a batch.
describe('sentBatchCount', () => {
  test('a draft is not counted, whatever it holds', () => {
    expect(
      sentBatchCount([{ status: 'approved' }, { status: 'submitted' }, { status: 'draft' }]),
    ).toBe(2);
  });

  test('rejected, in-run and archived batches were sent', () => {
    expect(
      sentBatchCount([
        { status: 'rejected' },
        { status: 'in_run' },
        { status: 'archived' },
      ]),
    ).toBe(3);
  });

  test('nothing loaded yet', () => {
    expect(sentBatchCount(undefined)).toBe(0);
  });
});
