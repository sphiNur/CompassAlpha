/**
 * Polls /health/version and compares the running build's id with the
 * server's. On mismatch (server has shipped a new build), shows a
 * non-dismissable toast that, when tapped, reloads the page so the
 * iPhone Telegram WebView can fetch the new index.html.
 *
 * The build id lives in `<meta name="compass-build">` in index.html and
 * is interpolated by vite.config.ts at build time.
 */
import { useEffect, useRef } from 'react';
import { useToast } from '@compass/ui';

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
  const promptedRef = useRef(false);

  useEffect(() => {
    const running = getRunningBuildId();
    if (!running) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      try {
        // Bypass any browser cache.
        const url = '/health/version?t=' + Date.now();
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { commit?: string };
        const server = data.commit;
        if (!server || server === running) return;
        if (promptedRef.current) return;
        promptedRef.current = true;
        toast.info(
          'Tap to reload now',
          'New version available',
        );
        // Auto-reload after 30s in case the user doesn't tap.
        setTimeout(() => {
          if (!cancelled) window.location.reload();
        }, 30_000);
      } catch {
        // Network errors are fine — we'll try again next interval.
      }
    };

    // Initial check after first paint settles.
    timer = setTimeout(() => void check(), 5_000);
    const handle = setInterval(() => void check(), POLL_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(handle);
      window.removeEventListener('focus', onFocus);
    };
  }, [toast]);
}
