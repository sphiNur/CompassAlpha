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
 *   4. Wire the Reload / Reset & reload buttons to onClick handlers
 *      (CSP forbids inline onclick=).
 *
 * NOT inside the SPA bundle: this script must run BEFORE the bundle
 * loads, including in the failure case where the bundle never loads
 * at all. Keep it dependency-free vanilla JS, no transpilation.
 */
(function () {
  // ---- 1. Locale detection ---------------------------------------------------
  var tg = window.Telegram && window.Telegram.WebApp;
  var langRaw =
    (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code) ||
    navigator.language ||
    'en';
  var lang = (function (l) {
    l = String(l).toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh';
    if (l.indexOf('ru') === 0) return 'ru';
    if (l.indexOf('uz') === 0) return 'uz';
    return 'en';
  })(langRaw);
  document.documentElement.lang = lang;

  var TEXT = {
    en: {
      startingUp: 'Starting up…',
      bootFailed: 'Boot failed',
      timeout: 'App did not start within 12 s. Likely a JS module loading error.',
      reload: 'Reload',
      reset: 'Reset & reload',
    },
    zh: {
      startingUp: '启动中…',
      bootFailed: '启动失败',
      timeout: '应用 12 秒内未启动，可能是 JS 模块加载失败。',
      reload: '重新加载',
      reset: '清除数据并重启',
    },
    ru: {
      startingUp: 'Запуск…',
      bootFailed: 'Ошибка запуска',
      timeout: 'Приложение не запустилось за 12 секунд. Вероятно, ошибка загрузки JS.',
      reload: 'Перезагрузить',
      reset: 'Сбросить и перезагрузить',
    },
    uz: {
      startingUp: 'Ishga tushmoqda…',
      bootFailed: 'Ishga tushishda xato',
      timeout: '12 soniya ichida ishga tushmadi. JS modulini yuklashda xato boʻlishi mumkin.',
      reload: 'Qayta yuklash',
      reset: 'Tozalab qayta yuklash',
    },
  };
  var t = TEXT[lang];

  // Set static labels.
  var subEl = document.querySelector('[data-boot-starting]');
  if (subEl) subEl.textContent = t.startingUp;
  var failedEl = document.querySelector('#boot-error [data-msg]');
  if (failedEl) failedEl.textContent = t.bootFailed;
  var reloadBtn = document.getElementById('boot-reload-btn');
  if (reloadBtn) reloadBtn.textContent = t.reload;
  var resetBtn = document.getElementById('boot-reset-btn');
  if (resetBtn) resetBtn.textContent = t.reset;

  // ---- 2. Error capture ------------------------------------------------------
  var bootShown = false;
  function showBootError(msg, stack) {
    if (bootShown) return;
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
  setTimeout(function () {
    if (!document.documentElement.classList.contains('ready')) {
      showBootError(t.timeout, '');
    }
  }, 12000);

  // ---- 4. Bind buttons (CSP forbids inline onclick=) ------------------------
  function bindButtons() {
    var rl = document.getElementById('boot-reload-btn');
    if (rl)
      rl.addEventListener('click', function () {
        location.reload();
      });
    var rs = document.getElementById('boot-reset-btn');
    if (rs)
      rs.addEventListener('click', function () {
        try {
          localStorage.removeItem('compass.auth');
          sessionStorage.clear();
        } catch (_) {
          /* storage unavailable; just reload */
        }
        location.reload();
      });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButtons);
  } else {
    bindButtons();
  }
})();
