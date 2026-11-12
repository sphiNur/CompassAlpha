import { describe, expect, test } from 'bun:test';
import { COMMON_TIME_ZONES, deviceTimeZones, timeZoneChoices } from '../timeZones';

describe('store time zone choices (ADM2-41)', () => {
  test('common zones first; the rest without them', () => {
    const { common, other } = timeZoneChoices('', ['Asia/Tashkent', 'Europe/Berlin', 'UTC']);
    expect(common).toEqual([...COMMON_TIME_ZONES]);
    expect(other).toEqual(['Europe/Berlin', 'UTC']);
  });

  test("a store's zone that no list has is offered first", () => {
    expect(timeZoneChoices('Asia/Calcutta', ['Asia/Kolkata']).common[0]).toBe('Asia/Calcutta');
    expect(timeZoneChoices('Europe/Berlin', ['Europe/Berlin']).common).toEqual([
      ...COMMON_TIME_ZONES,
    ]);
  });

  test('every common zone is one the runtime knows (no misspelt id)', () => {
    const all = deviceTimeZones();
    expect(all.length).toBeGreaterThan(100);
    expect(COMMON_TIME_ZONES.filter((zone) => !all.includes(zone))).toEqual([]);
  });
});
