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
 *                  the network fails. An online user always gets the
 *                  current deploy.
 *   - /assets/*    Vite's content-hashed files never change under one
 *                  URL: served from the cache once seen, so a lazy page
 *                  chunk opened offline still loads. Trimmed to the
 *                  newest MAX_ASSETS entries so old deploys age out.
 *   - other files  of the app's own origin under / (boot.css,
 *                  boot-guard.js): network first, cache as fallback.
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
 * The server sends `Vary: Origin` (CORS). A module script asks with an
 * Origin header and a precached copy was stored without one, so a plain
 * match missed it and an offline reload after the first visit still
 * failed. Hashed assets and the shell do not differ by Origin.
 */
var MATCH = { ignoreVary: true };

/** Which strategy a request gets: 'page' | 'asset' | 'static' | null (untouched). */
function route(request, origin) {
  if (request.method !== 'GET') return null;
  var url = new URL(request.url);
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

function trimAssets(cache) {
  return cache.keys().then(function (keys) {
    var assets = keys.filter(function (k) {
      return new URL(k.url).pathname.indexOf('/assets/') === 0;
    });
    var extra = assets.length - MAX_ASSETS;
    return Promise.all(
      assets.slice(0, Math.max(0, extra)).map(function (k) {
        return cache.delete(k);
      }),
    );
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
    if (!res.ok || res.type !== 'basic') return undefined;
    return res
      .clone()
      .text()
      .then(function (html) {
        return caches.open(CACHE).then(function (c) {
          return c.put(SHELL_KEY, res).then(function () {
            return Promise.all(
              shellAssetUrls(html).map(function (u) {
                return c.add(u).catch(function () {
                  /* one missing file must not fail the install */
                });
              }),
            );
          });
        });
      });
  });
}

/** Cache files the page already loaded before this worker controlled it. */
function cacheUrls(urls) {
  return caches.open(CACHE).then(function (c) {
    return Promise.all(
      urls.map(function (u) {
        var kind = route({ method: 'GET', url: u, mode: 'no-cors' }, self.location.origin);
        if (kind !== 'asset' && kind !== 'static') return undefined;
        return c.match(u, MATCH).then(function (hit) {
          if (hit) return undefined;
          return c.add(u).catch(function () {});
        });
      }),
    );
  });
}

/** A proxy's answer while the API (or the whole origin) is down. */
function isOriginDown(status) {
  return status >= 500 && status <= 599;
}

function networkFirst(request, cacheKey, cacheOnOriginDown) {
  return fetch(request)
    .then(function (res) {
      if (res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) {
          return c.put(cacheKey || request, copy);
        });
        return res;
      }
      if (cacheOnOriginDown && isOriginDown(res.status)) {
        return caches.match(cacheKey || request, MATCH).then(function (hit) {
          return hit || res;
        });
      }
      return res;
    })
    .catch(function (err) {
      return caches.match(cacheKey || request, MATCH).then(function (hit) {
        if (hit) return hit;
        throw err;
      });
    });
}

function cacheFirst(request) {
  return caches.match(request, MATCH).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (res) {
      if (res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) {
          return c.put(request, copy).then(function () {
            return trimAssets(c);
          });
        });
      }
      return res;
    });
  });
}

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    precacheShell().catch(function () {
      /* offline or the origin is down: the next online visit fills the cache */
    }),
  );
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
  if (kind === 'page') event.respondWith(networkFirst(event.request, SHELL_KEY, true));
  else if (kind === 'asset') event.respondWith(cacheFirst(event.request));
  else if (kind === 'static') event.respondWith(networkFirst(event.request, undefined, true));
});
