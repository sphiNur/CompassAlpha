/**
 * Top-level error boundary. Without this, any render-time exception causes
 * React to unmount the whole tree, leaving the user staring at the empty
 * `<div id="root">` element + body bg — i.e. a black screen on dark
 * Telegram themes. With this, we render a recoverable fatal screen and
 * (if the client logger is initialized) ship the error to `system.log`.
 *
 * main.tsx renders it around <App />. Review COREWEB1-17 (2026-11-12): it
 * used to be the first thing App returned, so an error in App's own hooks
 * (Telegram start-up, the query and tRPC clients) unmounted everything,
 * and once the language arrived main.tsx removed the splash with
 * boot-guard's error on it: a blank page with no way out.
 */
import { Component } from 'react';
import { clearLocalSession } from '../lib/localSession';
import { reloadApp } from '../lib/reload';
import type { ErrorInfo, ReactNode } from 'react';
import { createI18n, ensureCatalog, isLoaded, type Locale } from '@compass/i18n';
import { startLocale } from '../lib/startLocale';

/**
 * Resolve the user's locale WITHOUT hooks (2026-07-30).
 *
 * ErrorBoundary is the outermost component — it wraps App, and so
 * ThemeProvider and UiLabelsBridge — so it can't use `useI18n()` and
 * can't read any React context: it is the ancestor of all of them.
 * lib/bootLocale reads the persisted session straight from storage, then
 * the platform hint.
 *
 * A crash before any catalog arrived (no catalog is bundled since
 * DX-PFE-2) draws keys for the moment componentDidCatch takes to fetch
 * the language — or English when that fails — and draw again. A
 * mid-session crash (the realistic case) has the catalog long loaded.
 */
const crashLocale = (): Locale => startLocale();

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  copied?: boolean;
}

/**
 * DX-SHL-16 (2026-11-01): the error text and stack the administrator may
 * need, kept off the screen (staff saw an English trace) and copied on
 * request instead.
 */
export function crashDetails(error: Error): string {
  const message = error.message ?? String(error);
  const stack = error.stack ?? '';
  return [message, stack.split('\n').slice(0, 8).join('\n'), `at ${new Date().toISOString()}`]
    .filter(Boolean)
    .join('\n\n');
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Best-effort: ship to client logger if it's initialized. We import the
    // module dynamically to avoid a circular dep through telemetry → logger
    // → ... at module-load time of this file.
    void import('@compass/telemetry').then((m) => {
      try {
        m.getLogger().error(error, info.componentStack ?? 'react');
      } catch {
        /* logger not yet booted — fall through */
      }
    });
    // Always echo to console in case telemetry is dead.
    console.error('[ErrorBoundary]', error, info);
    // AUTH-27 (2026-10-30): a crash before the language chunk arrived drew
    // the screen in English until a retry. Fetch it now and draw again.
    const locale = crashLocale();
    if (!isLoaded(locale)) {
      // Offline, ensureCatalog falls back to English.
      void ensureCatalog(locale).then(() => this.forceUpdate());
    }
  }

  override render(): ReactNode {
    if (this.state.error) {
      const error = this.state.error;
      // Resolved per render rather than in a field: the locale catalog may
      // land between the crash and a re-render, and this screen is sticky
      // (the user sits on it), so picking the language up late still helps.
      const { t } = createI18n(crashLocale());
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100%',
            padding: '24px',
            color: 'var(--c-fg, #1d1d1f)',
            background: 'var(--c-bg, #f5f5f7)',
            fontFamily: 'var(--font-sans, -apple-system, system-ui, sans-serif)',
            textAlign: 'center',
            gap: '12px',
          }}
        >
          {/* Review COREWEB1-23 (2026-11-11): no 64 px ⚠ over a title that
              says the same (UI-1). */}
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{t('boot.crashTitle')}</h1>
          <p style={{ fontSize: 14, opacity: 0.7, margin: 0, maxWidth: 320 }}>
            {t('boot.crashBody')}
          </p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(crashDetails(error))
                .then(() => this.setState({ copied: true }))
                .catch(() => {
                  /* clipboard refused: nothing to copy to */
                });
            }}
            style={{
              padding: '10px 20px',
              borderRadius: 9999,
              background: 'transparent',
              color: 'var(--c-action, #0066cc)',
              border: 0,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            {this.state.copied ? t('boot.detailsCopied') : t('boot.copyDetails')}
          </button>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null, copied: false });
            }}
            // Review COREWEB1-25 (2026-11-11): the action colour is light
            // blue in the dark theme, and white on it was 2.4:1.
            style={{
              padding: '10px 20px',
              borderRadius: 9999,
              background: 'var(--c-action, #0066cc)',
              color: 'var(--c-action-fg, white)',
              border: 0,
              fontSize: 15,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t('boot.tryAgain')}
          </button>
          <button
            type="button"
            onClick={() => {
              void clearLocalSession().then(() => reloadApp('error-boundary'));
            }}
            style={{
              padding: '10px 20px',
              borderRadius: 9999,
              background: 'transparent',
              color: 'var(--c-fg-muted, #6e6e73)',
              // The kit's hairline: a black one vanished on the dark theme.
              border: '1px solid var(--c-divider, rgba(0,0,0,0.12))',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            {t('boot.resetAndReload')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
