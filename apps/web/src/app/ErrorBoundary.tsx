/**
 * Top-level error boundary. Without this, any render-time exception causes
 * React to unmount the whole tree, leaving the user staring at the empty
 * `<div id="root">` element + body bg — i.e. a black screen on dark
 * Telegram themes. With this, we render a recoverable fatal screen and
 * (if the client logger is initialized) ship the error to `system.log`.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
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
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      const message = this.state.error.message ?? String(this.state.error);
      const stack = this.state.error.stack ?? '';
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
          <div style={{ fontSize: 64 }} aria-hidden>
            ⚠
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
            Something broke before the app could render.
          </h1>
          <p style={{ fontSize: 14, opacity: 0.7, margin: 0, maxWidth: 320 }}>
            The error has been reported. Try closing and reopening the Mini App.
            If it keeps happening, share the trace below with your administrator.
          </p>
          <pre
            style={{
              maxWidth: '92vw',
              maxHeight: '40vh',
              overflow: 'auto',
              background: 'rgba(0,0,0,0.06)',
              padding: 12,
              borderRadius: 12,
              fontSize: 11,
              textAlign: 'left',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {message}
            {stack ? '\n\n' + stack.split('\n').slice(0, 8).join('\n') : ''}
          </pre>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
            }}
            style={{
              padding: '10px 20px',
              borderRadius: 9999,
              background: 'var(--c-action, #0066cc)',
              color: 'white',
              border: 0,
              fontSize: 15,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.removeItem('compass.auth');
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
            style={{
              padding: '10px 20px',
              borderRadius: 9999,
              background: 'transparent',
              color: 'var(--c-fg-muted, #6e6e73)',
              border: '1px solid rgba(0,0,0,0.12)',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reset session and reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
