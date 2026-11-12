/**
 * The choices of the store time zone picker (review ADM2-41, 2026-11-12).
 *
 * A store's time zone was a text field that wanted an IANA name
 * ("Asia/Tashkent"); a misspelt one was refused on save. It is a list now:
 * the zones of the countries the app is used in first, then every other
 * zone the device knows. The store's own zone stays in the list even where
 * the device does not know it.
 */

/** Uzbekistan, its neighbours, Russia and China, west to east. */
export const COMMON_TIME_ZONES = [
  'Europe/Moscow',
  'Asia/Tashkent',
  'Asia/Almaty',
  'Asia/Dushanbe',
  'Asia/Ashgabat',
  'Asia/Yekaterinburg',
  'Asia/Bishkek',
  'Asia/Novosibirsk',
  'Asia/Shanghai',
] as const;

/** Every zone the runtime knows; none where it cannot list them. */
export function deviceTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/**
 * The common zones, with `current` first when no list has it, and the
 * zones of `all` that are not common.
 */
export function timeZoneChoices(
  current: string,
  all: readonly string[],
): { common: string[]; other: string[] } {
  const common: string[] = [...COMMON_TIME_ZONES];
  if (current && !common.includes(current) && !all.includes(current)) common.unshift(current);
  const isCommon = new Set(common);
  return { common, other: all.filter((zone) => !isCommon.has(zone)) };
}
