/**
 * SHL-5 (2026-10-30): one page's crash used to replace the whole app,
 * navigation included, with "the app failed to start" and a raw stack;
 * Retry crashed again because the broken tab was the persisted one.
 * This boundary wraps a single page: the bar stays, another tab works,
 * and Retry re-mounts just the page. Shell keys it by tab, so switching
 * tabs clears it too.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
}

export class PageErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void import('@compass/telemetry').then((m) => {
      try {
        m.getLogger().error(error, info.componentStack ?? 'page');
      } catch {
        /* logger not booted */
      }
    });
    // eslint-disable-next-line no-console
    console.error('[PageErrorBoundary]', error, info);
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback(() => this.setState({ failed: false }));
    return this.props.children;
  }
}
