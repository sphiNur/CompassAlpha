import { describe, expect, it } from 'bun:test';
import { changedFields, hasChanges } from '../editPatch';

describe('changedFields (ADM2-24)', () => {
  type Fields = {
    name: string;
    contactPhone: string | null;
    notes: string | null;
    sortIndex: number;
  };
  const opened: Fields = { name: 'Stall 1', contactPhone: null, notes: 'old', sortIndex: 3 };

  it('keeps only what differs from what the editor opened with', () => {
    const changes = changedFields({ ...opened, notes: 'new', contactPhone: '+1' }, opened);
    expect(changes).toEqual({ notes: 'new', contactPhone: '+1' });
    expect(hasChanges(changes)).toBe(true);
  });

  it('a cleared field is a change to null; an untouched form changes nothing', () => {
    expect(changedFields({ ...opened, notes: null }, opened)).toEqual({ notes: null });
    const none = changedFields({ ...opened }, opened);
    expect(none).toEqual({});
    expect(hasChanges(none)).toBe(false);
  });
});
