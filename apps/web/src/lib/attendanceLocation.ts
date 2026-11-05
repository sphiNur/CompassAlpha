/**
 * One location fix for a clock-in (attendance, 2026-11-05). Telegram's
 * LocationManager (Bot API 8.0) first: it asks inside Telegram and works
 * where the web view's own geolocation is blocked; the browser API
 * otherwise.
 */
export type Fix = { lat: number; lng: number; accuracy: number };
export type LocationFailure = 'denied' | 'unavailable' | 'timeout';

interface TgLocationData {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number | null;
}
interface TgLocationManager {
  isInited: boolean;
  isLocationAvailable: boolean;
  isAccessRequested: boolean;
  isAccessGranted: boolean;
  init(cb?: () => void): void;
  getLocation(cb: (data: TgLocationData | null) => void): void;
  openSettings(): void;
}

type TgApp = { LocationManager?: TgLocationManager; isVersionAtLeast?: (v: string) => boolean };

function tgLocation(): TgLocationManager | null {
  const tg = (window as unknown as { Telegram?: { WebApp?: TgApp } }).Telegram?.WebApp;
  // Older clients log "not supported" on every call; ask first.
  if (!tg?.LocationManager || !tg.isVersionAtLeast?.('8.0')) return null;
  return tg.LocationManager;
}

class LocationError extends Error {
  constructor(public readonly reason: LocationFailure) {
    super(reason);
  }
}

export function isLocationError(e: unknown): e is LocationError {
  return e instanceof LocationError;
}

function viaTelegram(lm: TgLocationManager): Promise<Fix> {
  return new Promise((resolve, reject) => {
    const run = () => {
      if (!lm.isLocationAvailable) return reject(new LocationError('unavailable'));
      if (lm.isAccessRequested && !lm.isAccessGranted) return reject(new LocationError('denied'));
      lm.getLocation((data) => {
        if (!data) return reject(new LocationError(lm.isAccessGranted ? 'unavailable' : 'denied'));
        resolve({
          lat: data.latitude,
          lng: data.longitude,
          accuracy: data.horizontal_accuracy ?? 9999,
        });
      });
    };
    if (lm.isInited) run();
    else lm.init(run);
  });
}

function viaBrowser(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new LocationError('unavailable'));
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) =>
        reject(
          new LocationError(err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable'),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

export async function currentLocation(): Promise<Fix> {
  const lm = tgLocation();
  if (lm) {
    try {
      return await viaTelegram(lm);
    } catch (e) {
      // A Telegram client without location support still has the browser.
      if (isLocationError(e) && e.reason === 'denied') throw e;
    }
  }
  return viaBrowser();
}

/** Telegram's own settings page for this bot's location access, when there is one. */
export function openLocationSettings(): boolean {
  const lm = tgLocation();
  if (!lm) return false;
  lm.openSettings();
  return true;
}
