/**
 * Review TEST3-08 (2026-11-10): the location fix behind every clock-in had
 * no test. Telegram's LocationManager is asked first; a refusal there is
 * final, and anything else falls back to the browser's geolocation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  currentLocation,
  distanceMeters,
  isLocationError,
  openLocationSettings,
  type Fix,
  type LocationFailure,
} from '../attendanceLocation';

const g = globalThis as { window?: unknown };
const realWindow = g.window;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  g.window = realWindow;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
});

const TG_FIX: TelegramLocationData = { latitude: 41.3, longitude: 69.24, horizontal_accuracy: 12 };
const BROWSER_FIX: Fix = { lat: 41.31, lng: 69.25, accuracy: 30 };

/**
 * A browser whose geolocation answers with a fix or an error code, or that
 * has no geolocation at all. Returns the options of every request.
 */
function browser(answer: { fix: Fix } | { code: number } | 'none'): PositionOptions[] {
  const requests: PositionOptions[] = [];
  const geolocation = {
    getCurrentPosition(
      ok: PositionCallback,
      fail: PositionErrorCallback,
      options: PositionOptions,
    ): void {
      requests.push(options);
      if (answer !== 'none' && 'fix' in answer) {
        const { lat, lng, accuracy } = answer.fix;
        ok({ coords: { latitude: lat, longitude: lng, accuracy } } as GeolocationPosition);
      } else if (answer !== 'none') {
        fail({ code: answer.code } as GeolocationPositionError);
      }
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: answer === 'none' ? {} : { geolocation },
    configurable: true,
    writable: true,
  });
  return requests;
}

/**
 * Telegram with a LocationManager in the given state: granted, ready and
 * answering TG_FIX unless told otherwise. Returns the calls it received.
 */
function telegram(
  state: Partial<
    Pick<
      TelegramLocationManagerGlobal,
      'isInited' | 'isLocationAvailable' | 'isAccessRequested' | 'isAccessGranted'
    >
  > & { data?: TelegramLocationData | null; modern?: boolean } = {},
): string[] {
  const calls: string[] = [];
  const { data = TG_FIX, modern = true, ...flags } = state;
  const manager: TelegramLocationManagerGlobal = {
    isInited: true,
    isLocationAvailable: true,
    isAccessRequested: true,
    isAccessGranted: true,
    ...flags,
    init(cb) {
      calls.push('init');
      manager.isInited = true;
      cb?.();
    },
    getLocation(cb) {
      calls.push('getLocation');
      cb(data);
    },
    openSettings() {
      calls.push('openSettings');
    },
  };
  g.window = {
    Telegram: { WebApp: { LocationManager: manager, isVersionAtLeast: () => modern } },
  };
  return calls;
}

/** The reason `currentLocation` failed with, or the fix it returned. */
async function outcome(): Promise<LocationFailure | Fix> {
  try {
    return await currentLocation();
  } catch (e) {
    if (isLocationError(e)) return e.reason;
    throw e;
  }
}

describe('currentLocation: Telegram first', () => {
  test('a granted fix comes from Telegram, and the browser is not asked', async () => {
    telegram();
    const requests = browser({ fix: BROWSER_FIX });
    expect(await outcome()).toEqual({ lat: 41.3, lng: 69.24, accuracy: 12 });
    expect(requests).toEqual([]);
  });

  test('a LocationManager that is not ready is initialised first', async () => {
    const calls = telegram({ isInited: false });
    browser('none');
    await outcome();
    expect(calls).toEqual(['init', 'getLocation']);
  });

  test('a fix without an accuracy counts as 9999 m, never as precise', async () => {
    browser('none');
    for (const horizontal_accuracy of [null, undefined]) {
      telegram({ data: { latitude: 1, longitude: 2, horizontal_accuracy } });
      expect(await outcome()).toEqual({ lat: 1, lng: 2, accuracy: 9999 });
    }
  });

  test('a refusal in Telegram is final: the browser is not asked behind it', async () => {
    const calls = telegram({ isAccessRequested: true, isAccessGranted: false });
    const requests = browser({ fix: BROWSER_FIX });
    expect(await outcome()).toBe('denied');
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  test('no fix and no access (the prompt was dismissed) is a refusal too', async () => {
    telegram({ isAccessRequested: false, isAccessGranted: false, data: null });
    const requests = browser({ fix: BROWSER_FIX });
    expect(await outcome()).toBe('denied');
    expect(requests).toEqual([]);
  });

  test('Telegram without location falls back to the browser', async () => {
    const calls = telegram({ isLocationAvailable: false });
    const requests = browser({ fix: BROWSER_FIX });
    expect(await outcome()).toEqual(BROWSER_FIX);
    expect(calls).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test('access granted but no fix falls back to the browser', async () => {
    telegram({ data: null });
    browser({ fix: BROWSER_FIX });
    expect(await outcome()).toEqual(BROWSER_FIX);
  });

  test('a Telegram client older than Bot API 8.0 is not asked at all', async () => {
    const calls = telegram({ modern: false });
    browser({ fix: BROWSER_FIX });
    expect(await outcome()).toEqual(BROWSER_FIX);
    expect(calls).toEqual([]);
  });

  test('outside Telegram the browser answers', async () => {
    g.window = {};
    browser({ fix: BROWSER_FIX });
    expect(await outcome()).toEqual(BROWSER_FIX);
  });
});

describe('currentLocation: the browser', () => {
  test('asks for a fresh, precise fix within 15 s', async () => {
    g.window = {};
    const requests = browser({ fix: BROWSER_FIX });
    await outcome();
    expect(requests).toEqual([{ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }]);
  });

  test('error codes read as denied, unavailable and timeout', async () => {
    g.window = {};
    const reasons: Array<LocationFailure | Fix> = [];
    for (const code of [1, 2, 3]) {
      browser({ code });
      reasons.push(await outcome());
    }
    expect(reasons).toEqual(['denied', 'unavailable', 'timeout']);
  });

  test('a browser without geolocation is unavailable', async () => {
    g.window = {};
    browser('none');
    expect(await outcome()).toBe('unavailable');
  });

  test('other errors are not location errors', () => {
    expect(isLocationError(new Error('denied'))).toBe(false);
  });
});

describe('openLocationSettings', () => {
  test("opens Telegram's own page for the bot, where there is one", () => {
    const calls = telegram();
    expect(openLocationSettings()).toBe(true);
    expect(calls).toEqual(['openSettings']);
  });

  test('says there is none outside Telegram and in older clients', () => {
    g.window = {};
    expect(openLocationSettings()).toBe(false);
    const calls = telegram({ modern: false });
    expect(openLocationSettings()).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('distanceMeters', () => {
  test('about 111 m per 0.001° of latitude, as the server measures it', () => {
    const a = { lat: 41.3, lng: 69.24 };
    const b = { lat: 41.301, lng: 69.24 };
    expect(Math.round(distanceMeters(a, b))).toBe(111);
    expect(distanceMeters(b, a)).toBeCloseTo(distanceMeters(a, b), 9);
    expect(distanceMeters(a, a)).toBe(0);
  });
});
