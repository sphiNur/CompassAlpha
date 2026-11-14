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
import { runningBuildId } from '../lib/build';
import { waitingWriteCount } from '../lib/outbox/engine';
import { reloadApp } from '../lib/reload';
import { versionCheck } from '../lib/versionCheck';

const POLL_MS = 30_000;

export function useVersionCheck(): void {
  const toast = useToast();
  const i18n = useI18n();
  const queryClient = useQueryClient();
  // Read through refs so a language change or a new toast context does
  // not restart the polling effect.
  const latest = useRef({ toast, i18n, queryClient });
  latest.current = { toast, i18n, queryClient };

  useEffect(() => {
    const running = runningBuildId();
    if (!running) return;

    const versions = versionCheck({
      running,
      async serverBuild() {
        // Bypass any browser cache. Review MWD-03 (modern-web-guidance:
        // deprioritize-background-fetches): a background poll, at low priority.
        const res = await fetch('/health/version?t=' + Date.now(), {
          cache: 'no-store',
          priority: 'low',
        });
        if (!res.ok) return null;
        return ((await res.json()) as { commit?: string }).commit ?? null;
      },
      now: () => Date.now(),
      hidden: () => document.visibilityState === 'hidden',
      // Review COREWEB2-22: this session's own waiting writes. The whole
      // outbox also holds other people's (kept for their own session for
      // up to a week), which held the background update back as long.
      queuedWrites: waitingWriteCount,
      openSheets: () => getSheetCount(),
      mutationsInFlight: () => latest.current.queryClient.isMutating(),
      prompt(reload) {
        const { toast: t, i18n: tr } = latest.current;
        t.show(tr.t('app.update.title'), {
          ttlMs: 0,
          actions: [
            { label: tr.t('app.update.later') },
            { label: tr.t('app.update.reload'), emphasis: 'primary', onClick: reload },
          ],
        });
      },
      reload: (reason) => reloadApp(reason, running),
    });

    const check = () => void versions.check();
    const onVisibility = () => versions.visibilityChanged();

    // Initial check after first paint settles.
    const timer = setTimeout(check, 5_000);
    const handle = setInterval(check, POLL_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearTimeout(timer);
      clearInterval(handle);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
