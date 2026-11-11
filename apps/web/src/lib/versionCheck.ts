/**
 * What useVersionCheck does on each poll and visibility change, without its
 * timers, fetch or DOM, so the choices are testable (review TEST3-08,
 * 2026-11-10). The hook's header says why a visible app is never reloaded.
 */
import { mayAutoReload, type ReloadReason } from './reload';

export interface VersionCheckDeps {
  /** The build this page runs. */
  running: string;
  /** The build the server runs, or null when it did not say; a rejection is no answer. */
  serverBuild(): Promise<string | null>;
  now(): number;
  hidden(): boolean;
  /** Writes waiting in the offline queue; a rejection counts as none. */
  queuedWrites(): Promise<number>;
  openSheets(): number;
  mutationsInFlight(): number;
  /** Shows the "new version" prompt; its Reload button calls `reload`. */
  prompt(reload: () => void): void;
  reload(reason: Extract<ReloadReason, 'update-accepted' | 'update-while-hidden'>): void;
}

export interface VersionCheck {
  /** One poll: ask the server, or, with an update waiting, try a background reload. */
  check(): Promise<void>;
  /** The page was hidden or shown. */
  visibilityChanged(): void;
}

export function versionCheck(deps: VersionCheckDeps): VersionCheck {
  let updateWaiting = false;
  let hiddenSince: number | null = deps.hidden() ? deps.now() : null;

  const tryBackgroundReload = async () => {
    if (hiddenSince === null) return;
    let queuedWrites = 0;
    try {
      queuedWrites = await deps.queuedWrites();
    } catch {
      /* IDB unavailable: nothing can be queued */
    }
    // Read after the wait: the page may have been shown meanwhile.
    const ok = mayAutoReload({
      hiddenForMs: hiddenSince === null ? null : deps.now() - hiddenSince,
      openSheets: deps.openSheets(),
      mutationsInFlight: deps.mutationsInFlight(),
      queuedWrites,
    });
    if (ok) deps.reload('update-while-hidden');
  };

  return {
    async check() {
      if (updateWaiting) return tryBackgroundReload();
      let server: string | null;
      try {
        server = await deps.serverBuild();
      } catch {
        return; // A network error: the next poll tries again.
      }
      if (!server || server === deps.running || updateWaiting) return;
      updateWaiting = true;
      // "Later" only dismisses; the background reload above still picks
      // the update up when nothing can be lost.
      deps.prompt(() => deps.reload('update-accepted'));
    },
    visibilityChanged() {
      hiddenSince = deps.hidden() ? deps.now() : null;
    },
  };
}
