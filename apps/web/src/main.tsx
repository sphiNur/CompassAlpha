import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { detectLocale, preloadCatalog } from '@compass/i18n';
import { App } from './app/App';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root not found');

// Replace the inline boot splash. We clear the splash node *before*
// createRoot renders so React doesn't have to fight an existing subtree.
const splash = document.getElementById('boot-splash');
if (splash) splash.remove();

// M3.14-D (2026-05-16): kick off the active locale's catalog chunk
// in parallel with the first React render. We don't know the
// authenticated user's preferred locale yet (auth store hasn't
// hydrated) so we guess from Telegram + navigator.language. If the
// guess is wrong (user is logged in as Uzbek but Telegram reports
// English), useEnsureLocale inside useI18n will load the correct
// one on the first hook call — at the cost of one extra fetch.
//
// en is statically imported and always available — no preload needed.
const tg = (window as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { language_code?: string } } } } }).Telegram?.WebApp;
const bootGuess = detectLocale(
  tg?.initDataUnsafe?.user?.language_code ?? navigator.language,
);
if (bootGuess !== 'en') preloadCatalog(bootGuess);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tell index.html that React mounted; the splash CSS guard hides any
// remaining boot error UI.
requestAnimationFrame(() => {
  document.documentElement.classList.add('ready');
});
