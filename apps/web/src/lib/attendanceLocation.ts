/**
 * One location fix for a clock-in (attendance, 2026-11-05). Telegram's
 * LocationManager (Bot API 8.0) first: it asks inside Telegram and works
 * where the web view's own geolocation is blocked; the browser API
 * otherwise.
 */
export type Fix = { lat: number; lng: number; accuracy: number };
export type LocationFailure = 'denied' | 'unavailable' | 'timeout';

type TgLocationManager = TelegramLocationManagerGlobal;

function tgLocation(): TgLocationManager | null {
  const tg = window.Telegram?.WebApp;
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

/** Great-circle distance in metres (as the server's, @compass/domain attendance). */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
