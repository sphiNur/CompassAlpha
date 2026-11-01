import { useSyncExternalStore } from 'react';

/**
 * Whether the browser reports a connection, as React state. DX-IX-9
 * (2026-11-01): writes that cannot wait in the outbox (review decisions)
 * are disabled offline with the reason shown, instead of failing after
 * the tap.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
