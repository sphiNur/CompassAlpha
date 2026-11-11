/**
 * The id this phone clocks in with (attendance, 2026-11-05). The server
 * binds a member to the first id it sees and refuses others while the
 * store requires the bound phone. Kept in Telegram's DeviceStorage when
 * the client has it (Bot API 9.0; survives a cleared web view) and in
 * localStorage as well.
 */
const KEY = 'compass.attendance.device';

type TgDeviceStorage = TelegramDeviceStorageGlobal;

function tgStorage(): TgDeviceStorage | null {
  const tg = window.Telegram?.WebApp;
  // Older clients log "not supported" on every call; ask first.
  if (!tg?.DeviceStorage || !tg.isVersionAtLeast?.('9.0')) return null;
  return tg.DeviceStorage;
}

function fresh(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readLocal(): string | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v && /^[A-Za-z0-9_-]{16,128}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function writeLocal(v: string): void {
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    /* storage blocked: the Telegram copy still holds it */
  }
}

function readTg(): Promise<string | null> {
  const st = tgStorage();
  if (!st) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500);
    try {
      st.getItem(KEY, (err, value) => {
        clearTimeout(timer);
        resolve(!err && value && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Telegram's copy, else this web view's, else a new id; then both copies
 * hold it. The app calls attendanceDeviceId, which reads once per page.
 */
export async function resolveDeviceId(): Promise<string> {
  const id = (await readTg()) ?? readLocal() ?? fresh();
  writeLocal(id);
  try {
    tgStorage()?.setItem(KEY, id);
  } catch {
    /* older client */
  }
  return id;
}

let cached: Promise<string> | null = null;

export function attendanceDeviceId(): Promise<string> {
  cached ??= resolveDeviceId();
  return cached;
}

export function devicePlatform(): string {
  return (window.Telegram?.WebApp?.platform ?? 'web').slice(0, 32);
}
