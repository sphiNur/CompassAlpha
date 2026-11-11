/**
 * Review TEST3-08 (2026-11-10): the id a phone clocks in with had no test.
 * The server binds a member to the first id it sees, so a phone that
 * forgets its id, or reads a damaged one, is refused at the next clock-in.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { attendanceDeviceId, devicePlatform, resolveDeviceId } from '../attendanceDevice';

const KEY = 'compass.attendance.device';
const TG_ID = 'telegram-copy-0123456789';
const LOCAL_ID = 'webview-copy-0123456789';

const g = globalThis as { window?: unknown };
const realWindow = g.window;

afterEach(() => {
  g.window = realWindow;
  jest.useRealTimers();
});

/** A web view's localStorage, or one the browser blocks. */
function webStorage(value?: string, blocked = false) {
  const items = new Map<string, string>(value === undefined ? [] : [[KEY, value]]);
  const check = () => {
    if (blocked) throw new Error('SecurityError');
  };
  return {
    items,
    getItem(k: string): string | null {
      check();
      return items.get(k) ?? null;
    },
    setItem(k: string, v: string): void {
      check();
      items.set(k, v);
    },
  };
}

type Answer = { value?: string | null; err?: unknown } | 'silent' | 'throws';

/** Telegram's DeviceStorage answering `answer`, recording what it is asked. */
function deviceStorage(answer: Answer, failWrites = false) {
  const calls: string[] = [];
  const saved = new Map<string, string>();
  const storage: TelegramDeviceStorageGlobal = {
    getItem(key, cb) {
      calls.push(`get ${key}`);
      if (answer === 'throws') throw new Error('not supported');
      if (answer !== 'silent') cb(answer.err ?? null, answer.value);
    },
    setItem(key, value) {
      calls.push(`set ${key}`);
      if (failWrites) throw new Error('not supported');
      saved.set(key, value);
    },
  };
  return { storage, calls, saved };
}

function install(opts: {
  local: ReturnType<typeof webStorage>;
  device?: TelegramDeviceStorageGlobal;
  modern?: boolean;
  platform?: string;
}): void {
  const { local, device, modern = true, platform } = opts;
  const inTelegram = device !== undefined || platform !== undefined;
  g.window = {
    localStorage: local,
    Telegram: inTelegram
      ? { WebApp: { DeviceStorage: device, isVersionAtLeast: () => modern, platform } }
      : undefined,
  };
}

describe('resolveDeviceId', () => {
  test("Telegram's copy wins, and the web view gets it too", async () => {
    const local = webStorage(LOCAL_ID);
    const tg = deviceStorage({ value: TG_ID });
    install({ local, device: tg.storage });
    expect(await resolveDeviceId()).toBe(TG_ID);
    expect(local.items.get(KEY)).toBe(TG_ID);
    expect(tg.saved.get(KEY)).toBe(TG_ID);
  });

  test("a damaged or missing Telegram copy falls back to the web view's", async () => {
    for (const answer of [
      { value: 'short' },
      { value: 'has spaces in it, 0123456789' },
      { value: null },
      { err: new Error('unavailable'), value: TG_ID },
      'throws' as const,
    ]) {
      const tg = deviceStorage(answer);
      install({ local: webStorage(LOCAL_ID), device: tg.storage });
      expect(await resolveDeviceId()).toBe(LOCAL_ID);
      // The good id is written back to Telegram.
      expect(tg.saved.get(KEY)).toBe(LOCAL_ID);
    }
  });

  test('a DeviceStorage that never answers is given up after 1.5 s', async () => {
    jest.useFakeTimers();
    install({ local: webStorage(LOCAL_ID), device: deviceStorage('silent').storage });
    let settled = false;
    const id = resolveDeviceId().then((v) => {
      settled = true;
      return v;
    });
    jest.advanceTimersByTime(1499);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await id).toBe(LOCAL_ID);
  });

  test('a Telegram client older than Bot API 9.0 is not asked', async () => {
    const tg = deviceStorage({ value: TG_ID });
    install({ local: webStorage(LOCAL_ID), device: tg.storage, modern: false });
    expect(await resolveDeviceId()).toBe(LOCAL_ID);
    expect(tg.calls).toEqual([]);
  });

  test("outside Telegram the web view's copy is used", async () => {
    install({ local: webStorage(LOCAL_ID) });
    expect(await resolveDeviceId()).toBe(LOCAL_ID);
  });

  test('with no copy anywhere a new random id is made and kept', async () => {
    const local = webStorage();
    install({ local });
    const id = await resolveDeviceId();
    expect(id).toMatch(/^[0-9a-f]{48}$/);
    expect(local.items.get(KEY)).toBe(id);
    install({ local: webStorage() });
    expect(await resolveDeviceId()).not.toBe(id);
  });

  test('a damaged web view copy is replaced', async () => {
    const local = webStorage('bad');
    install({ local });
    const id = await resolveDeviceId();
    expect(id).toMatch(/^[0-9a-f]{48}$/);
    expect(local.items.get(KEY)).toBe(id);
  });

  test('blocked storage or a failing Telegram write still gives an id', async () => {
    const tg = deviceStorage({ value: TG_ID }, true);
    install({ local: webStorage(undefined, true), device: tg.storage });
    expect(await resolveDeviceId()).toBe(TG_ID);
    install({ local: webStorage(undefined, true) });
    expect(await resolveDeviceId()).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe('attendanceDeviceId', () => {
  test('reads once per page and returns the same id after', async () => {
    const tg = deviceStorage({ value: TG_ID });
    install({ local: webStorage(), device: tg.storage });
    const first = attendanceDeviceId();
    expect(attendanceDeviceId()).toBe(first);
    expect(await first).toBe(TG_ID);
    expect(tg.calls.filter((c) => c.startsWith('get'))).toHaveLength(1);
  });
});

describe('devicePlatform', () => {
  test("is Telegram's platform name, cut to 32 characters, or web", () => {
    install({ local: webStorage(), platform: 'ios' });
    expect(devicePlatform()).toBe('ios');
    install({ local: webStorage(), platform: 'x'.repeat(40) });
    expect(devicePlatform()).toHaveLength(32);
    install({ local: webStorage() });
    expect(devicePlatform()).toBe('web');
  });
});
