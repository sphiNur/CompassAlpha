import { describe, expect, test } from 'bun:test';
import { DRAFT_MAX_AGE_MS, draftKey, forgetDraft, readDraft, writeDraft } from '../draftStore';

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const draft = { onlineRevenue: '1250000', operatingExpenseItems: [{ amount: '45000' }], wageItems: [] };

describe('settlement draft store', () => {
  test('round-trips a draft under a per-user, per-record key', () => {
    const s = memory();
    const key = draftKey('u1', 'store:2026-11-05:new:0');
    writeDraft(s, key, draft, 1000);
    expect(readDraft(s, key, 2000)).toEqual(draft);
    expect(readDraft(s, draftKey('u2', 'store:2026-11-05:new:0'), 2000)).toBeNull();
  });

  test('drops a stale or malformed entry', () => {
    const s = memory();
    const key = draftKey('u1', 'k');
    writeDraft(s, key, draft, 0);
    expect(readDraft(s, key, DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(s.map.has(key)).toBe(false);
    s.setItem(key, JSON.stringify({ at: 0, draft: { wageItems: 'x' } }));
    expect(readDraft(s, key, 1)).toBeNull();
    s.setItem(key, '{not json');
    expect(readDraft(s, key, 1)).toBeNull();
  });

  test('forget removes it; missing storage is a no-op', () => {
    const s = memory();
    const key = draftKey('u1', 'k');
    writeDraft(s, key, draft);
    forgetDraft(s, key);
    expect(readDraft(s, key)).toBeNull();
    writeDraft(null, key, draft);
    expect(readDraft(null, key)).toBeNull();
    forgetDraft(null, key);
  });

  test('a throwing storage never breaks the page', () => {
    const boom = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readDraft(boom, 'k')).toBeNull();
    writeDraft(boom, 'k', draft);
    forgetDraft(boom, 'k');
  });
});
