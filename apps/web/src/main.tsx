import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ensureCatalog } from '@compass/i18n';
import { App } from './app/App';
import './styles/index.css';
import { reloadForStaleChunk, STALE_CHUNK_RELOAD_WINDOW_MS } from './lib/reload';
import { startLocale } from './lib/startLocale';
import { preloadPage, savedTab } from './app/pageChunks';

// F10 (2026-10-30): after a deploy, a client that stayed open asks for
// lazy page chunks that no longer exist; the import failed into the root
// error boundary and the whole app became a crash page whose Retry failed
// again. Load the new version instead — online only (offline it is the
// network, and a reload would show Telegram's offline page), and not again
// within a minute if a reload did not help (the boundary then shows).
window.addEventListener('vite:preloadError', (event) => {
  if (!navigator.onLine) return;
  if (reloadForStaleChunk(STALE_CHUNK_RELOAD_WINDOW_MS)) event.preventDefault();
});

// N12 (2026-10-30): an offline reload showed a blank page — the document
// itself could not be fetched. public/sw.js keeps the last good shell.
// Production builds only: in dev it would cache Vite's modules. Where
// service workers are unavailable (some WebViews) this is a no-op.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* unsupported or blocked: the app works as before, online only */
    });
    // R2-SHL-1 (2026-10-31): this first page loaded before the worker
    // existed; hand it the files already loaded (lazy page chunks among
    // them) so an offline reload after this one visit finds them.
    void navigator.serviceWorker.ready.then((registration) => {
      const urls = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => url.startsWith(`${window.location.origin}/assets/`));
      registration.active?.postMessage({ type: 'compass:cache-urls', urls });
    });
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('Root not found');

// M3.14-D / DX-PFE-1 / DX-PFE-2 (2026-11-01): one startup path.
//   - The start language is the persisted session's own choice, else
//     Telegram's / the browser's (startLocale → lib/bootLocale).
//   - No catalog is bundled, English included, so there is no English to
//     flash: the boot splash stays up until that catalog is in (or English,
//     when it cannot be fetched — ensureCatalog).
//   - React renders at once underneath it, so auth, the saved-data restore
//     and the page's queries run while the catalog downloads; I18nGate keeps
//     the screens hidden until the catalog is in, so no raw key is ever shown.
//   - Review COREWEB1-02 (2026-11-09): the splash waits for the catalog
//     however long it takes. It used to give up after 8 s: the splash went,
//     I18nGate still hid the screens, and `.ready` told boot-guard.js's 12 s
//     failsafe that the app had started, so a slow or stuck catalog left a
//     blank screen with no spinner and no way out. Now the failsafe shows its
//     message and reload button over the splash; a catalog that lands later
//     still removes both.
//   - DX-PFE-3: the page the app reopens on is a lazy chunk; start it now.
const catalogReady = ensureCatalog(startLocale());
const reopenTab = (() => {
  try {
    return savedTab(window.localStorage);
  } catch {
    return null;
  }
})();
if (reopenTab) preloadPage(reopenTab);

// The splash lives inside #root; React would replace it on the first
// render. Lift it above the app instead and remove it once the catalog is
// in (`.ready` also tells boot-guard.js's failsafe that the app started).
const splash = document.getElementById('boot-splash');
if (splash) {
  splash.style.zIndex = '2147483000';
  document.body.appendChild(splash);
}
render(container);
void catalogReady.then(() => {
  document.documentElement.classList.add('ready');
  splash?.remove();
});

function render(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
