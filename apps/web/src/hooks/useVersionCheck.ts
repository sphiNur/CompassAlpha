/**
 * Polls /health/version and compares the running build's id with the
 * server's. On mismatch (server has shipped a new build) it shows a
 * prompt with explicit "Reload" / "Later" buttons that stays until one
 * is tapped. 2026-10-21 FE-05: the whole toast used to be the reload
 * button and sat on top of the page's Submit/Save, so a tap meant for
 * Save reloaded the app; now only the Reload button reloads.
 *
 * It does NOT reload a visible app on its own. It used to, 30 seconds
 * after the prompt, whatever the user was doing — so every deploy
 * refreshed the page under everyone online and discarded what they had
 * typed. The only unasked reload left is for an app that has been in the
 * background for a while with nothing to lose (see `mayAutoReload`).
 *
 * The build id lives in `<meta name="compass-build">` in index.html and
 * is interpolated by vite.config.ts at build time.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSheetCount, useToast } from '@compass/ui';
import { useI18n } from './useI18n';
import { outbox } from '../lib/idb';
import { mayAutoReload, reloadApp } from '../lib/reload';

const POLL_MS = 30_000;

function getRunningBuildId(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name="compass-build"]') as HTMLMetaElement | null;
  const v = meta?.content;
  if (!v || v === '%VITE_BUILD_SHA%') return null;
  return v;
}

export function useVersionCheck(): void {
  const toast = useToast();
  const i18n = useI18n();
  const queryClient = useQueryClient();
  // Read through refs so a language change or a new toast context does
  // not restart the polling effect.
  const latest = useRef({ toast, i18n, queryClient });
  latest.current = { toast, i18n, queryClient };

  useEffect(() => {
    const running = getRunningBuildId();
    if (!running) return;

    let updateWaiting = false;
    let hiddenSince: number | null = document.visibilityState === 'hidden' ? Date.now() : null;

    const tryBackgroundReload = async () => {
      if (!updateWaiting || hiddenSince === null) return;
      let queuedWrites = 0;
      try {
        queuedWrites = await outbox.size();
      } catch {
        /* IDB unavailable: nothing can be queued */
      }
      const ok = mayAutoReload({
        hiddenForMs: hiddenSince === null ? null : Date.now() - hiddenSince,
        openSheets: getSheetCount(),
        mutationsInFlight: latest.current.queryClient.isMutating(),
        queuedWrites,
      });
      if (ok) reloadApp('update-while-hidden', running);
    };

    const check = async () => {
      if (updateWaiting) {
        void tryBackgroundReload();
        return;
      }
      try {
        // Bypass any browser cache.
        const url = '/health/version?t=' + Date.now();
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { commit?: string };
        const server = data.commit;
        if (!server || server === running || updateWaiting) return;
        updateWaiting = true;
        const { toast: t, i18n: tr } = latest.current;
        t.show(tr.t('app.update.title'), {
          ttlMs: 0,
          actions: [
            // "Later" just dismisses; the hidden-app auto-reload above
            // still picks the update up when nothing can be lost.
            { label: tr.t('app.update.later') },
            {
              label: tr.t('app.update.reload'),
              emphasis: 'primary',
              onClick: () => reloadApp('update-accepted', running),
            },
          ],
        });
      } catch {
        // Network errors are fine — we'll try again next interval.
      }
    };

    const onVisibility = () => {
      hiddenSince = document.visibilityState === 'hidden' ? Date.now() : null;
    };

    // Initial check after first paint settles.
    const timer = setTimeout(() => void check(), 5_000);
    const handle = setInterval(() => void check(), POLL_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearTimeout(timer);
      clearInterval(handle);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
