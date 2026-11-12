import { describe, expect, test } from 'bun:test';
import {
  DRAFT_MAX_AGE_MS,
  draftKey,
  forgetDraft,
  pruneDrafts,
  readDraft,
  writeDraft,
} from '../draftStore';
import { memoryStorage, throwingStorage } from '../../../__tests__/helpers/storage';

const draft = {
  onlineRevenue: '1250000',
  operatingExpenseItems: [{ id: 'e1', amount: '45000', reason: 'Taxi' }],
  wageItems: [{ id: 'w1', amount: '150000', reason: '', personName: 'Alex', status: 'paid' }],
};

describe('settlement draft store', () => {
  test('round-trips a draft under a per-user, per-record key', () => {
    const s = memoryStorage();
    const key = draftKey('u1', 'store:2026-11-05:new:0');
    writeDraft(s, key, draft, 1000);
    expect(readDraft(s, key, 2000)).toEqual(draft);
    expect(readDraft(s, draftKey('u2', 'store:2026-11-05:new:0'), 2000)).toBeNull();
  });

  test('drops a stale or malformed entry', () => {
    const s = memoryStorage();
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
    const s = memoryStorage();
    const key = draftKey('u1', 'k');
    writeDraft(s, key, draft);
    forgetDraft(s, key);
    expect(readDraft(s, key)).toBeNull();
    writeDraft(null, key, draft);
    expect(readDraft(null, key)).toBeNull();
    forgetDraft(null, key);
  });

  test('a throwing storage never breaks the page', () => {
    const boom = throwingStorage();
    expect(readDraft(boom, 'k')).toBeNull();
    writeDraft(boom, 'k', draft);
    forgetDraft(boom, 'k');
  });

  test('a line or a field of the wrong shape is dropped (CONF-13)', () => {
    const s = memoryStorage();
    const key = draftKey('u1', 'k');
    for (const bad of [
      { ...draft, operatingExpenseItems: [{ id: 'e1', amount: 45000, reason: 'Taxi' }] },
      { ...draft, wageItems: [null] },
      { ...draft, wageItems: [{ id: 'w1', amount: '150000', reason: '', status: 'paid' }] },
      { ...draft, wageItems: [{ id: 'w1', amount: '150000', reason: '', personName: 'Alex' }] },
      { ...draft, onlineRevenue: 1250000 },
    ]) {
      s.setItem(key, JSON.stringify({ at: 0, draft: bad }));
      expect(readDraft(s, key, 1)).toBeNull();
      expect(s.map.has(key)).toBe(false);
    }
  });

  test('prune keeps the open draft and drops earlier versions and dead entries (CONF-13)', () => {
    const s = memoryStorage();
    const day = (rest: string) => draftKey('u1', `store:2026-11-05:${rest}`);
    const open = day('rec:3');
    const earlier = day('rec:2');
    const later = day('rec:4');
    const beforeTheRecord = day('new:0');
    const otherDay = draftKey('u1', 'store:2026-11-04:rec:1');
    const expired = draftKey('u1', 'store:2026-10-01:rec:1');
    const unrelated = 'someone.else';
    for (const key of [open, earlier, later, beforeTheRecord, otherDay]) {
      writeDraft(s, key, draft, 1000);
    }
    writeDraft(s, expired, draft, 0);
    s.setItem(draftKey('u1', 'broken'), '{not json');
    s.setItem(unrelated, 'kept');
    pruneDrafts(s, open, { prefix: day('rec:'), version: 3 }, DRAFT_MAX_AGE_MS + 1);
    // A later version's draft stays: the record shown may be a stale copy.
    expect([...s.map.keys()].sort()).toEqual(
      [open, later, beforeTheRecord, otherDay, unrelated].sort(),
    );
    pruneDrafts(null, open, null);
  });

  test('while the record loads, no draft is judged by its version (CONF-13)', () => {
    const s = memoryStorage();
    const saved = draftKey('u1', 'store:2026-11-05:rec:3');
    writeDraft(s, saved, draft, 1000);
    // Before the record arrives the page's key reads "new:0".
    pruneDrafts(s, draftKey('u1', 'store:2026-11-05:new:0'), null, 2000);
    expect(readDraft(s, saved, 2000)).toEqual(draft);
  });
});
