import { describe, expect, test } from 'bun:test';
import { trackDraftChange } from '../useDraftChanged';

describe('trackDraftChange (CMP-BUY-4)', () => {
  test('a sheet as it opened has no changes; typing makes one; undoing it clears it', () => {
    const opened = { current: null };
    expect(trackDraftChange(opened, 'sku-1', '{"qty":""}')).toBe(false);
    expect(trackDraftChange(opened, 'sku-1', '{"qty":"2"}')).toBe(true);
    expect(trackDraftChange(opened, 'sku-1', '{"qty":""}')).toBe(false);
  });

  test('opening another row starts from its own values', () => {
    const opened = { current: null };
    trackDraftChange(opened, 'sku-1', '{"qty":"2"}');
    expect(trackDraftChange(opened, 'sku-2', '{"qty":"5"}')).toBe(false);
  });

  test('a closed sheet forgets, so reopening the same row is unchanged', () => {
    const opened = { current: null };
    trackDraftChange(opened, 'sku-1', '{"qty":""}');
    trackDraftChange(opened, 'sku-1', '{"qty":"3"}');
    expect(trackDraftChange(opened, null, null)).toBe(false);
    expect(trackDraftChange(opened, 'sku-1', '{"qty":"3"}')).toBe(false);
  });
});
