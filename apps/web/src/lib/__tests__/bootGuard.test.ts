/**
 * P-7 (2026-10-31): index.html loads the Telegram SDK with `defer`, so it
 * runs after public/boot-guard.js instead of before it. What must hold:
 * the SDK still runs before the app's module script (document order), and
 * boot-guard picks the Telegram language and starts its 12 s failsafe
 * once the SDK has loaded, as it did while the SDK blocked it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const WEB = new URL('../../..', import.meta.url).pathname;
const html = readFileSync(`${WEB}index.html`, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const guard = readFileSync(`${WEB}public/boot-guard.js`, 'utf8');

describe('index.html script order', () => {
  it('defers the Telegram SDK and keeps it before boot-guard and the app', () => {
    const tg = html.indexOf('<script src="https://telegram.org/js/telegram-web-app.js" defer>');
    const bootGuard = html.indexOf('<script src="/boot-guard.js">');
    const app = html.indexOf('<script type="module"');
    expect(tg).toBeGreaterThan(-1);
    expect(tg).toBeLessThan(bootGuard);
    expect(bootGuard).toBeLessThan(app);
    // boot-guard must stay a classic blocking script: it installs the
    // error capture before anything else runs.
    expect(html).not.toMatch(/boot-guard\.js"[^>]*(defer|async)/);
  });
});

type Listener = () => void;

/** Just enough DOM to run boot-guard.js. */
function runGuard() {
  const el = () => ({
    textContent: '',
    style: {} as Record<string, string>,
    classList: { add() {}, contains: () => false },
    querySelector: () => null,
    addEventListener() {},
  });
  const nodes: Record<string, ReturnType<typeof el>> = {
    '[data-boot-starting]': el(),
    '#boot-error [data-msg]': el(),
    'boot-reload-btn': el(),
    'boot-reset-btn': el(),
  };
  const tgListeners: Record<string, Listener> = {};
  const tgScript = { addEventListener: (type: string, fn: Listener) => void (tgListeners[type] = fn) };
  let parsed = false;
  const timers: Array<{ fn: Listener; ms: number; cleared: boolean }> = [];
  const documentElement = { lang: '', classList: { contains: () => false } };
  const document = {
    documentElement,
    readyState: 'loading',
    querySelector: (sel: string) =>
      sel.includes('telegram-web-app') ? tgScript : parsed ? (nodes[sel] ?? null) : null,
    getElementById: (id: string) => (parsed ? (nodes[id] ?? null) : null),
    addEventListener() {},
  };
  const window: Record<string, unknown> = { addEventListener() {} };
  const setTimeout = (fn: Listener, ms: number) => timers.push({ fn, ms, cleared: false }) - 1;
  const clearTimeout = (id: number) => {
    if (timers[id]) timers[id].cleared = true;
  };
  new Function('window', 'document', 'navigator', 'setTimeout', 'clearTimeout', guard)(
    window,
    document,
    { language: 'en-US' },
    setTimeout,
    clearTimeout,
  );
  return {
    documentElement,
    nodes,
    timers,
    sdkLoaded(languageCode: string) {
      parsed = true;
      window.Telegram = { WebApp: { initDataUnsafe: { user: { language_code: languageCode } } } };
      tgListeners.load?.();
    },
    sdkFailed() {
      parsed = true;
      tgListeners.error?.();
    },
  };
}

describe('boot-guard with a deferred Telegram SDK', () => {
  it('guesses from navigator first, then takes Telegram’s language once the SDK ran', () => {
    const g = runGuard();
    expect(g.documentElement.lang).toBe('en');
    g.sdkLoaded('ru');
    expect(g.documentElement.lang).toBe('ru');
    // The splash exists by then, so its labels are translated too.
    expect(g.nodes['[data-boot-starting]']!.textContent).toBe('Запуск…');
    expect(g.nodes['boot-reload-btn']!.textContent).toBe('Перезагрузить');
  });

  it('restarts the 12 s failsafe when the SDK has run, keeping one live timer', () => {
    const g = runGuard();
    const failsafes = () => g.timers.filter((t) => t.ms === 12000);
    expect(failsafes().length).toBe(1);
    g.sdkLoaded('zh');
    expect(failsafes().length).toBe(2);
    expect(failsafes().filter((t) => !t.cleared).length).toBe(1);
  });

  it('a failed SDK load still translates from navigator and keeps the failsafe', () => {
    const g = runGuard();
    g.sdkFailed();
    expect(g.documentElement.lang).toBe('en');
    expect(g.nodes['[data-boot-starting]']!.textContent).toBe('Starting up…');
    expect(g.timers.filter((t) => t.ms === 12000 && !t.cleared).length).toBe(1);
  });
});
