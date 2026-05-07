import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root not found');

// Replace the inline boot splash. We clear the splash node *before*
// createRoot renders so React doesn't have to fight an existing subtree.
const splash = document.getElementById('boot-splash');
if (splash) splash.remove();

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
