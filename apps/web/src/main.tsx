import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { preloadCatalog } from '@compass/i18n';
import { App } from './app/App';
import './styles/index.css';
import { reloadForStaleChunk } from './lib/reload';
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
  if (reloadForStaleChunk(60_000)) event.preventDefault();
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

// Replace the inline boot splash. We clear the splash node *before*
// createRoot renders so React doesn't have to fight an existing subtree.
const splash = document.getElementById('boot-splash');
if (splash) splash.remove();

// M3.14-D (2026-05-16): kick off the active locale's catalog chunk in
// parallel with the first React render. I18nGate (hooks/useI18n) hides
// the screens until it is in: no catalog is bundled, en included
// (DX-PFE-2). startLocale reads the signed-in user's own choice from the
// persisted session, else guesses from Telegram + navigator.language.
preloadCatalog(startLocale());
// DX-PFE-3 (2026-11-01): the page the app reopens on is a lazy chunk;
// start it now rather than after auth and the saved-data restore have
// drawn the Shell — they used to run one after the other.
const reopenTab = (() => {
  try {
    return savedTab(window.localStorage);
  } catch {
    return null;
  }
})();
if (reopenTab) preloadPage(reopenTab);

// `/?kit` shows the component kit on its own, without signing in. The
// condition is a build-time constant, so a production bundle contains
// neither the branch nor the page.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('kit')) {
  void import('./pages/KitGallery').then(({ KitGallery }) => {
    createRoot(container).render(
      <StrictMode>
        <KitGallery />
      </StrictMode>,
    );
  });
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Tell index.html that React mounted; the splash CSS guard hides any
// remaining boot error UI.
requestAnimationFrame(() => {
  document.documentElement.classList.add('ready');
});
