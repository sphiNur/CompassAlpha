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

type Listener = (event?: unknown) => void;

/** Just enough DOM to run boot-guard.js. */
function runGuard(language = 'en-US') {
  const el = (id = '') => {
    const classes: string[] = [];
    return {
      id,
      textContent: '',
      style: {} as Record<string, string>,
      classes,
      classList: { add: (c: string) => void classes.push(c), contains: () => false },
      querySelector: (sel: string): unknown =>
        sel === '[data-msg]' ? nodes['#boot-error [data-msg]'] : null,
      addEventListener() {},
    };
  };
  const nodes: Record<string, ReturnType<typeof el>> = {
    '[data-boot-starting]': el(),
    '#boot-error [data-msg]': el(),
    'boot-error': el('boot-error'),
    'boot-reload-btn': el('boot-reload-btn'),
    'boot-reset-btn': el('boot-reset-btn'),
  };
  const docListeners: Record<string, Listener> = {};
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
    addEventListener: (type: string, fn: Listener) => void (docListeners[type] = fn),
  };
  const window: Record<string, unknown> = { addEventListener() {} };
  const setTimeout = (fn: Listener, ms: number) => timers.push({ fn, ms, cleared: false }) - 1;
  const clearTimeout = (id: number) => {
    if (timers[id]) timers[id].cleared = true;
  };
  const storage = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
      clear: () => items.clear(),
    };
  };
  const localStorage = storage();
  const sessionStorage = storage();
  const location = { reloads: 0, reload: () => void location.reloads++ };
  new Function(
    'window',
    'document',
    'navigator',
    'setTimeout',
    'clearTimeout',
    'location',
    'localStorage',
    'sessionStorage',
    guard,
  )(
    window,
    document,
    { language },
    setTimeout,
    clearTimeout,
    location,
    localStorage,
    sessionStorage,
  );
  return {
    documentElement,
    nodes,
    timers,
    location,
    localStorage,
    sessionStorage,
    /** The document is parsed, but DOMContentLoaded has not fired. */
    parsed() {
      parsed = true;
    },
    /** A click on the node with this id, as the browser delivers it to the document. */
    click(id: string) {
      const node = nodes[id]!;
      docListeners.click?.({
        target: { closest: (sel: string) => (sel.split(', ').includes(`#${id}`) ? node : null) },
      });
    },
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

describe('boot-guard buttons (COREWEB1-01)', () => {
  // DOMContentLoaded waits for the deferred SDK and the app's module
  // script, which is what is stuck when the 12 s failsafe fires.
  const timedOut = (language?: string) => {
    const g = runGuard(language);
    g.parsed();
    g.timers.find((t) => t.ms === 12000 && !t.cleared)!.fn();
    return g;
  };

  it('work when the failsafe fires before DOMContentLoaded', () => {
    const g = timedOut();
    expect(g.nodes['boot-error']!.classes).toContain('show');
    g.click('boot-reload-btn');
    expect(g.location.reloads).toBe(1);
    expect(JSON.parse(g.sessionStorage.getItem('compass.lastReload')!).reason).toBe('boot-guard');
  });

  it('reset clears the saved sign-in before reloading', () => {
    const g = timedOut();
    g.localStorage.setItem('compass.auth', '{}');
    g.click('boot-reset-btn');
    expect(g.localStorage.getItem('compass.auth')).toBeNull();
    expect(g.location.reloads).toBe(1);
  });

  it('are labelled in the person’s language when the error shows', () => {
    const g = timedOut('ru-RU');
    expect(g.nodes['boot-reload-btn']!.textContent).toBe('Перезагрузить');
    expect(g.nodes['boot-reset-btn']!.textContent).toBe('Сбросить и перезагрузить');
    expect(g.nodes['#boot-error [data-msg]']!.textContent).toBe(
      'Приложение не запустилось. Проверьте связь и перезагрузите.',
    );
  });

  it('a click elsewhere does nothing', () => {
    const g = timedOut();
    g.click('[data-boot-starting]');
    expect(g.location.reloads).toBe(0);
  });
});

describe('boot timeout text (DX-SHL-17)', () => {
  it('says what to do, without developer terms or the timer', () => {
    const lines = [...guard.matchAll(/timeout: '([^']*)'/g)].map((m) => m[1]!);
    expect(lines.length).toBe(4);
    for (const text of lines) {
      expect(text).not.toMatch(/JS|module|модул|modul|12/i);
    }
  });
});
