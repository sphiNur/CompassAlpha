/**
 * App-shell service worker (N12, 2026-10-30).
 *
 * Reloading the page with no connection showed the browser's own
 * "no internet" page — or, inside Telegram, a blank WebView — because
 * the document itself could not be fetched. Nothing in the app bundle
 * can help with that: the bundle is what failed to load. This worker
 * keeps the last good copy of the shell so an offline reload starts the
 * app, which then says it is offline (Shell's banner), keeps the
 * session, and lets the outbox replay once the network is back.
 *
 * Deliberately small, and never in the way while online:
 *   - page loads   network first; the last good index.html only when
 *                  the network fails or has not answered within
 *                  NETWORK_TIMEOUT_MS. An online user always gets the
 *                  current deploy.
 *   - /assets/*    Vite's content-hashed files never change under one
 *                  URL: served from the cache once seen, so a lazy page
 *                  chunk opened offline still loads. Trimmed to the
 *                  MAX_ASSETS most recently used entries so old deploys
 *                  age out (see trimAssets).
 *   - other files  of the app's own origin under / (boot.css,
 *                  boot-guard.js): network first, cache as fallback.
 *   - Telegram SDK the one script from another origin: network first,
 *                  cache as fallback (TELEGRAM_SDK).
 *   - everything else — /trpc, /health, /ws, uploads, other origins,
 *     non-GET — is not touched at all: data is never served from here.
 *
 * First visit (R2-SHL-1, 2026-10-31): the page that registers this
 * worker loaded before it existed, so nothing was cached and an offline
 * reload after ONE online visit still failed. Install now fetches the
 * shell and the entry files it names, and the page sends the asset URLs
 * it already loaded (main.tsx).
 *
 * Origin down (R2-ENG-5, 2026-10-31): when the server is unreachable
 * the proxy answers a page load with its own 502/503/504/52x page — a
 * response, not a network failure — so the cached shell was skipped. A
 * page load answered 5xx gets the cached shell too (and boot.css /
 * boot-guard.js their cached copies).
 *
 * Kill switch: deploy a sw.js whose fetch handler is removed and which
 * calls `self.registration.unregister()` on activate; browsers check
 * this file for updates on every navigation.
 */
var CACHE = 'compass-shell-v1';
var MAX_ASSETS = 300;
var SHELL_KEY = '/index.html';
var PASS_THROUGH = ['/trpc', '/health', '/ws', '/upload', '/api', '/sw.js'];
/**
 * COREWEB1-14 (2026-11-11): an offline start without the SDK ran as in a
 * plain browser: no Telegram theme, BackButton, SettingsButton or haptics,
 * and in fullscreen the app's own top bar sat under Telegram's buttons.
 * The browser's own cache keeps it only as long as telegram.org allows
 * (four days, 2026-11) and loses it when the WebView's cache is cleared;
 * this copy stays. index.html loads it without `crossorigin`, so the
 * answer is opaque: the <script> can run it, this worker cannot read it
 * (status 0).
 */
var TELEGRAM_SDK = 'https://telegram.org/js/telegram-web-app.js';
/**
 * COREWEB1-15 (2026-11-11): on a connection that is up but carries
 * nothing, a load waited for the browser's own timeout, which can take
 * minutes, before the cached copy was tried. After this long the cached
 * copy answers, when there is one; the network's answer, if it comes,
 * still replaces it in the cache.
 */
var NETWORK_TIMEOUT_MS = 4000;
/**
 * The server sends `Vary: Origin` (CORS). A module script asks with an
 * Origin header and a precached copy was stored without one, so a plain
 * match missed it and an offline reload after the first visit still
 * failed. Hashed assets and the shell do not differ by Origin.
 */
var MATCH = { ignoreVary: true };

/** Which strategy a request gets: 'page' | 'asset' | 'static' | 'sdk' | null (untouched). */
function route(request, origin) {
  if (request.method !== 'GET') return null;
  var url = new URL(request.url);
  if (url.origin + url.pathname === TELEGRAM_SDK) return 'sdk';
  if (url.origin !== origin) return null;
  for (var i = 0; i < PASS_THROUGH.length; i++) {
    if (url.pathname === PASS_THROUGH[i] || url.pathname.indexOf(PASS_THROUGH[i] + '/') === 0) {
      return null;
    }
  }
  if (request.mode === 'navigate') return 'page';
  if (url.pathname.indexOf('/assets/') === 0) return 'asset';
  if (/\.(css|js|svg|png|ico|woff2?|webmanifest)$/.test(url.pathname)) return 'static';
  return null;
}
self.__compassSwRoute = route; // for the unit test only

/**
 * Whether an answer may be kept (COREWEB1-15). The server answers a path
 * it does not know with index.html and 200 (only a missing /assets/ file
 * is a 404, since OPS-14), so a request for a stray .js or .png kept the
 * page under that file's name, served from then on in its place. A page
 * must be HTML and a file must not be. The SDK's opaque answer cannot be
 * read and is kept as it is.
 */
function cacheable(res, kind) {
  if (kind === 'sdk') return res.type === 'opaque' || (res.type === 'cors' && res.ok);
  if (!res.ok || res.type !== 'basic') return false;
  var html = (res.headers.get('content-type') || '').toLowerCase().indexOf('text/html') === 0;
  return kind === 'page' ? html : !html;
}
self.__compassSwCacheable = cacheable; // for the unit test only

function noop() {}

/** Fetch `url` and keep the answer when it passes `cacheable`. */
function fetchInto(cache, url, kind, init) {
  return fetch(url, init).then(function (res) {
    return cacheable(res, kind) ? cache.put(url, res) : undefined;
  });
}

function pathOf(url) {
  return new URL(url, self.location.origin).pathname;
}

/**
 * Drop the oldest assets beyond MAX_ASSETS, never one the cached shell
 * names (the entry files an offline reload needs first) or one in `keep`
 * (what the page just reported loading).
 *
 * COREWEB1-06 (2026-11-09): the order is the cache's own, oldest written
 * first, and a cache hit was never written again. Chunks that stay the
 * same across deploys (vendor, unchanged pages) were therefore the first
 * to go once new deploys filled the cache, while still in use, and the
 * next offline reload failed to start. A hit is now written again once
 * per worker (touch), which moves it to the end, and the shell's own
 * files are kept whatever their place.
 */
function trimAssets(cache, keep) {
  return Promise.all([
    cache.keys(),
    cache.match(SHELL_KEY, MATCH).then(function (shell) {
      return shell ? shell.text().then(shellAssetUrls) : [];
    }),
  ]).then(function (found) {
    var assets = found[0].filter(function (k) {
      return pathOf(k.url).indexOf('/assets/') === 0;
    });
    var extra = assets.length - MAX_ASSETS;
    if (extra <= 0) return undefined;
    var kept = found[1].concat((keep || []).map(pathOf));
    var removable = assets.filter(function (k) {
      return kept.indexOf(pathOf(k.url)) === -1;
    });
    return Promise.all(
      removable.slice(0, extra).map(function (k) {
        return cache.delete(k);
      }),
    );
  });
}
self.__compassTrimAssets = trimAssets; // for the unit test only

/** Assets written again by this worker already (see trimAssets). */
var touched = {};

/**
 * Write a cache hit again, once per worker, so it counts as recently used.
 * Keyed by the URL alone, as every asset is stored: a key carrying the
 * page's Origin header would not replace an entry stored without one
 * (`Vary: Origin`) but sit beside it.
 */
function touch(cache, url, hit) {
  var key = pathOf(url);
  if (touched[key]) return Promise.resolve();
  touched[key] = true;
  return cache.put(url, hit).catch(function () {
    touched[key] = false;
  });
}

/** Same-origin shell files named by index.html (Vite entry chunks, CSS, boot files). */
function shellAssetUrls(html) {
  var out = [];
  var re = /(?:src|href)="(\/(?:assets\/[^"]+|boot\.css|boot-guard\.js))"/g;
  var m;
  while ((m = re.exec(html))) {
    if (out.indexOf(m[1]) === -1) out.push(m[1]);
  }
  return out;
}
self.__compassShellAssetUrls = shellAssetUrls; // for the unit test only

/** Cache the shell and its entry files so the very first visit works offline. */
function precacheShell() {
  return fetch('/', { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
    if (!cacheable(res, 'page')) return undefined;
    return res
      .clone()
      .text()
      .then(function (html) {
        return caches.open(CACHE).then(function (c) {
          return c.put(SHELL_KEY, res).then(function () {
            return Promise.all(
              shellAssetUrls(html).map(function (u) {
                var kind = u.indexOf('/assets/') === 0 ? 'asset' : 'static';
                return fetchInto(c, u, kind).catch(function () {
                  /* one missing file must not fail the install */
                });
              }),
            );
          });
        });
      });
  });
}

/** The SDK too: the first visit loaded it before this worker existed. */
function precacheSdk() {
  return caches.open(CACHE).then(function (c) {
    return fetchInto(c, TELEGRAM_SDK, 'sdk', { mode: 'no-cors' });
  });
}

/**
 * Cache the files the page loaded (sent on every load, main.tsx): files it
 * loaded before this worker controlled it, and a fresh "recently used"
 * mark for the ones already cached.
 */
function cacheUrls(urls) {
  return caches.open(CACHE).then(function (c) {
    return Promise.all(
      urls.map(function (u) {
        var kind = route({ method: 'GET', url: u, mode: 'no-cors' }, self.location.origin);
        if (kind !== 'asset' && kind !== 'static') return undefined;
        return c.match(u, MATCH).then(function (hit) {
          if (hit) return touch(c, u, hit);
          return fetchInto(c, u, kind).catch(noop);
        });
      }),
    ).then(function () {
      return trimAssets(c, urls);
    });
  });
}

/** A proxy's answer while the API (or the whole origin) is down. */
function isOriginDown(status) {
  return status >= 500 && status <= 599;
}

/**
 * Network first, for pages, the boot files and the SDK: the network's
 * answer, or the cached copy when the network fails, when the origin is
 * down (5xx; an opaque answer has no status and is passed on as it is),
 * or when nothing has come back within NETWORK_TIMEOUT_MS.
 *
 * Returns the answer and `done`, which settles once a fresh copy is
 * stored. COREWEB1-15: the write used to run outside the event, so a
 * worker stopped right after answering could lose it and keep the old
 * shell.
 */
function networkFirst(request, kind, cacheKey) {
  var key = cacheKey || request;
  var copy = null;
  var network = fetch(request).then(function (res) {
    if (cacheable(res, kind)) copy = res.clone();
    return res;
  });
  var done = network
    .then(function () {
      if (!copy) return undefined;
      return caches.open(CACHE).then(function (c) {
        return c.put(key, copy);
      });
    })
    .catch(noop);
  function cached() {
    return caches.match(key, MATCH).catch(noop);
  }
  var response = new Promise(function (resolve, reject) {
    var answered = false;
    function answer(res) {
      if (answered) return;
      answered = true;
      resolve(res);
    }
    var timer = setTimeout(function () {
      cached().then(function (hit) {
        if (hit) answer(hit);
      });
    }, NETWORK_TIMEOUT_MS);
    network.then(
      function (res) {
        clearTimeout(timer);
        if (!isOriginDown(res.status)) {
          answer(res);
          return;
        }
        cached().then(function (hit) {
          answer(hit || res);
        });
      },
      function (err) {
        clearTimeout(timer);
        cached().then(function (hit) {
          if (hit) answer(hit);
          else if (!answered) {
            answered = true;
            reject(err);
          }
        });
      },
    );
  });
  return { response: response, done: done };
}

/**
 * Cache first, for Vite's hashed files. Returns the answer and `done`,
 * which settles once the write it started (a fresh copy, or a hit's
 * "recently used" mark) is finished.
 */
function cacheFirst(request) {
  var settle;
  var done = new Promise(function (resolve) {
    settle = resolve;
  });
  var response = caches.match(request, MATCH).then(function (hit) {
    if (hit) {
      var again = hit.clone();
      settle(
        caches.open(CACHE).then(function (c) {
          return touch(c, request.url, again);
        }),
      );
      return hit;
    }
    return fetch(request).then(function (res) {
      if (!cacheable(res, 'asset')) {
        settle();
        return res;
      }
      var copy = res.clone();
      settle(
        caches.open(CACHE).then(function (c) {
          return c.put(request.url, copy).then(function () {
            return trimAssets(c);
          });
        }),
      );
      return res;
    });
  });
  response.catch(function () {
    settle();
  });
  return { response: response, done: done.catch(noop) };
}

self.addEventListener('install', function (event) {
  self.skipWaiting();
  // Offline, or the origin or telegram.org is down: the next online visit
  // fills the cache.
  event.waitUntil(Promise.all([precacheShell().catch(noop), precacheSdk().catch(noop)]));
});

self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== 'compass:cache-urls' || !Array.isArray(data.urls)) return;
  event.waitUntil(cacheUrls(data.urls.slice(0, MAX_ASSETS)).catch(function () {}));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (n) {
              return n.indexOf('compass-shell-') === 0 && n !== CACHE;
            })
            .map(function (n) {
              return caches.delete(n);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener('fetch', function (event) {
  var kind = route(event.request, self.location.origin);
  if (!kind) return;
  var job;
  if (kind === 'asset') job = cacheFirst(event.request);
  else if (kind === 'page') job = networkFirst(event.request, kind, SHELL_KEY);
  else if (kind === 'sdk') job = networkFirst(event.request, kind, TELEGRAM_SDK);
  else job = networkFirst(event.request, kind);
  event.respondWith(job.response);
  event.waitUntil(job.done);
});
