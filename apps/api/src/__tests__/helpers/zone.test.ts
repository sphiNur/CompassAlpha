import { describe, expect, test } from 'bun:test';
import { dateInTz } from '@compass/domain';
import { middayZone } from './zone';

const hourIn = (at: Date, zone: string) =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(
      at,
    ),
  );

describe('middayZone', () => {
  test('at any time of day, it is midday in the zone it names', () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 59]) {
        const at = new Date(Date.UTC(2026, 10, 30, hour, minute));
        const zone = middayZone(at);
        expect(hourIn(at, zone)).toBe(12);
        // Eleven hours either way stays on that day.
        const day = dateInTz(at, zone);
        expect(dateInTz(new Date(at.getTime() - 11 * 3600_000), zone)).toBe(day);
        expect(dateInTz(new Date(at.getTime() + 11 * 3600_000), zone)).toBe(day);
      }
    }
  });

  test('the names count the other way round from the offset', () => {
    expect(middayZone(new Date('2026-11-10T15:30:00Z'))).toBe('Etc/GMT+3');
    expect(middayZone(new Date('2026-11-10T01:30:00Z'))).toBe('Etc/GMT-11');
    expect(middayZone(new Date('2026-11-10T00:00:00Z'))).toBe('Etc/GMT+12');
    expect(middayZone(new Date('2026-11-10T12:59:00Z'))).toBe('UTC');
  });
});
