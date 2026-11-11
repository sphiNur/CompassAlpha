/**
 * Pre-React boot guard (M3.18, launch hardening 2026-05-16).
 *
 * Previously this code lived inline in index.html. The launch CSP
 * (`script-src 'self' https://telegram.org`) blocks inline scripts
 * and inline event handlers, so the boot guard was externalized
 * here. The Telegram WebApp SDK is the only third-party script.
 *
 * Responsibilities:
 *   1. Detect the user's locale (Telegram → navigator) and set
 *      <html lang> + localized boot splash strings BEFORE React
 *      mounts. If the SPA fails to load, the user sees a comprehensible
 *      message in their own language instead of "Failed to start"
 *      English-only (P1-7 fix, 2026-05-16).
 *   2. Catch window errors / unhandled rejections during the boot
 *      window and surface them in the splash error UI.
 *   3. 12-second failsafe: if React hasn't mounted (no .ready class
 *      on <html>) by then, force the error UI so the user can recover.
 *   4. Make the Reload / Reset session and reload buttons work (CSP
 *      forbids inline onclick=).
 *   5. Set <html data-theme data-color-scheme> before the first paint,
 *      as ThemeProvider will once React runs (COREWEB1-26).
 *
 * NOT inside the SPA bundle: this script must run BEFORE the bundle
 * loads, including in the failure case where the bundle never loads
 * at all. Keep it dependency-free vanilla JS, no transpilation.
 */
(function () {
  // ---- 1. Locale detection ---------------------------------------------------
  // P-7 (2026-10-31): the Telegram SDK is now loaded with `defer`, so it
  // runs after this script (still before the app's module script, which
  // keeps document order). Until it has run, guess from navigator; when
  // it has, detect again from Telegram's language (see onTelegramLoaded).
  function detectLang() {
    var tg = window.Telegram && window.Telegram.WebApp;
    var raw =
      (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code) ||
      navigator.language ||
      'en';
    var l = String(raw).toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh';
    if (l.indexOf('ru') === 0) return 'ru';
    if (l.indexOf('uz') === 0) return 'uz';
    return 'en';
  }
  var lang = detectLang();
  document.documentElement.lang = lang;

  // DX-SHL-17 (2026-11-01): `timeout` is shown to staff; it says what to
  // do, without "JS module" or a timer.
  var TEXT = {
    en: {
      startingUp: 'Starting up…',
      bootFailed: 'Boot failed',
      timeout: 'The app could not start. Check your connection and reload.',
      reload: 'Reload',
      reset: 'Reset session and reload',
    },
    zh: {
      startingUp: '启动中…',
      bootFailed: '启动失败',
      timeout: '应用没能启动。请检查网络后重新加载。',
      reload: '重新加载',
      reset: '清除登录状态并重新加载',
    },
    ru: {
      startingUp: 'Запуск…',
      bootFailed: 'Ошибка запуска',
      timeout: 'Приложение не запустилось. Проверьте связь и перезагрузите.',
      reload: 'Перезагрузить',
      reset: 'Выйти и перезагрузить',
    },
    uz: {
      startingUp: 'Ishga tushmoqda…',
      bootFailed: 'Ishga tushishda xato',
      timeout: 'Ilova ishga tushmadi. Internetni tekshirib, qayta yuklang.',
      reload: 'Qayta yuklash',
      reset: 'Sessiyani tozalab qayta yuklash',
    },
  };
  var t = TEXT[lang];

  // Set static labels. This script runs in <head>, before the splash in
  // <body> is parsed, so this is called again once the document is parsed
  // (onTelegramLoaded / DOMContentLoaded) and when the error box is shown;
  // until P-7 the labels stayed English because this only ever ran here.
  function applyLabels() {
    var subEl = document.querySelector('[data-boot-starting]');
    if (subEl) subEl.textContent = t.startingUp;
    var failedEl = document.querySelector('#boot-error [data-msg]');
    if (failedEl && !bootShown) failedEl.textContent = t.bootFailed;
    var reloadBtn = document.getElementById('boot-reload-btn');
    if (reloadBtn) reloadBtn.textContent = t.reload;
    var resetBtn = document.getElementById('boot-reset-btn');
    if (resetBtn) resetBtn.textContent = t.reset;
  }

  // ---- 2. Error capture ------------------------------------------------------
  var bootShown = false;
  function showBootError(msg, stack) {
    if (bootShown) return;
    // COREWEB1-01: the failsafe can fire before DOMContentLoaded (that
    // waits for the stuck SDK or app script), so label the buttons now.
    applyLabels();
    bootShown = true;
    var el = document.getElementById('boot-error');
    if (!el) return;
    el.classList.add('show');
    var msgEl = el.querySelector('[data-msg]');
    if (msgEl) msgEl.textContent = msg || t.bootFailed;
    var pre = el.querySelector('pre');
    if (pre && stack) pre.textContent = stack;
    var spin = document.getElementById('boot-spinner');
    if (spin) spin.style.display = 'none';
  }

  window.addEventListener('error', function (e) {
    showBootError(e.message || t.bootFailed, (e.error && e.error.stack) || '');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    showBootError(r.message || t.bootFailed, r.stack || String(r));
  });

  // ---- 3. 12-second failsafe -------------------------------------------------
  // Counted from when the Telegram SDK has run (restarted below), as it
  // was while the SDK blocked this script; if the SDK never loads, from
  // here, so a stuck telegram.org still ends in the recovery UI.
  var failsafe = null;
  function startFailsafe() {
    if (failsafe !== null) clearTimeout(failsafe);
    failsafe = setTimeout(function () {
      if (!document.documentElement.classList.contains('ready')) {
        showBootError(t.timeout, '');
      }
    }, 12000);
  }
  startFailsafe();

  // ---- 3b. Telegram SDK loaded (P-7) ----------------------------------------
  // A deferred script's load event fires after it has run, and after the
  // document is parsed, so the splash exists and window.Telegram is set.
  function onTelegramLoaded() {
    lang = detectLang();
    document.documentElement.lang = lang;
    t = TEXT[lang];
    applyLabels();
    startFailsafe();
  }
  var tgScript = document.querySelector('script[src*="telegram-web-app.js"]');
  if (tgScript && !(window.Telegram && window.Telegram.WebApp)) {
    tgScript.addEventListener('load', onTelegramLoaded);
    tgScript.addEventListener('error', onTelegramLoaded);
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyLabels);
  } else {
    applyLabels();
  }

  // ---- 4. Buttons (CSP forbids inline onclick=) -----------------------------
  // Same record apps/web/src/lib/reload.ts writes, so the next page load
  // can report why this one ended.
  function noteReload() {
    try {
      sessionStorage.setItem(
        'compass.lastReload',
        JSON.stringify({ reason: 'boot-guard', at: Date.now(), fromBuild: null }),
      );
    } catch (_) {
      /* storage unavailable */
    }
  }

  // COREWEB1-01: one click listener on the document, registered now. The
  // buttons used to be bound on DOMContentLoaded, which waits for the
  // deferred SDK and the app's module script: exactly what is stuck when
  // the failsafe shows them, so they did nothing.
  document.addEventListener('click', function (e) {
    var target = e.target;
    var btn = target && target.closest ? target.closest('#boot-reload-btn, #boot-reset-btn') : null;
    if (!btn) return;
    // Reset removes the keys apps/web/src/lib/localSession.ts removes: the
    // saved sign-in and the saved tab (COREWEB1-16; the test checks they
    // agree). Session storage stays: it holds the launch's one-time markers,
    // and emptying it made the reload accept an invite already accepted.
    // The saved copy of read answers, in IndexedDB, is left to the app: a
    // bad copy breaks the screen it is drawn on, inside React, and the
    // crash screen's reset drops it.
    if (btn.id === 'boot-reset-btn') {
      try {
        localStorage.removeItem('compass.auth');
        localStorage.removeItem('compass.nav.v1');
      } catch (_) {
        /* storage unavailable; just reload */
      }
    }
    noteReload();
    location.reload();
  });

  // ---- 5. Colour scheme before the first paint (COREWEB1-26) ----------------
  // The app's colours (tokens.css) follow <html data-theme data-color-scheme>,
  // which ThemeProvider sets once React runs. Until then every screen, the
  // splash included, was light, also in a dark Telegram. Set them now as
  // ThemeProvider will: the saved theme, else 'native' (VITE_DEFAULT_THEME's
  // default), and Telegram's scheme, else the phone's. The deferred SDK has
  // not run yet, so Telegram's colours come from where it reads them: its
  // copy in sessionStorage (newer, it wins in the SDK too), else the launch
  // URL. Last in this file, and never thrown out of: a colour is not worth
  // the boot error screen, which the capture above would show.
  function telegramScheme() {
    var params = null;
    try {
      params = JSON.parse(sessionStorage.getItem('__telegram__themeParams') || 'null');
    } catch (_) {
      /* unreadable: try the launch URL */
    }
    if (!params || !params.bg_color) {
      var m = /[#&?]tgWebAppThemeParams=([^&]*)/.exec(String(location.hash || ''));
      try {
        params = m ? JSON.parse(decodeURIComponent(m[1].replace(/\+/g, '%20'))) : null;
      } catch (_) {
        params = null;
      }
    }
    var hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String((params && params.bg_color) || ''));
    if (!hex) return null;
    var h = hex[1].length === 3 ? hex[1].replace(/(.)/g, '$1$1') : hex[1];
    var r = parseInt(h.substr(0, 2), 16);
    var g = parseInt(h.substr(2, 2), 16);
    var b = parseInt(h.substr(4, 2), 16);
    // The SDK's own test (isColorDark), so the two agree.
    return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) < 120 ? 'dark' : 'light';
  }
  function applyScheme() {
    var root = document.documentElement;
    if (!root.dataset) return;
    var theme = 'native';
    try {
      var saved = localStorage.getItem('compass.theme');
      if (saved === 'native' || saved === 'apple' || saved === 'dark') theme = saved;
    } catch (_) {
      /* storage unavailable */
    }
    var scheme = telegramScheme();
    if (!scheme) {
      var phone = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      scheme = phone && phone.matches ? 'dark' : 'light';
    }
    root.dataset.theme = theme;
    root.dataset.colorScheme = scheme;
  }
  try {
    applyScheme();
  } catch (_) {
    /* ThemeProvider sets them once the app runs */
  }
})();
