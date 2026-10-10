/**
 * Every full-page reload the app performs goes through here, so that
 * "the page suddenly refreshed" always has a recorded cause.
 *
 * The reason is written to sessionStorage BEFORE reloading and reported
 * by the next page load. Logging it only on the way out is not enough:
 * the logger flushes on an interval and the reload usually wins the race.
 */
import { getLogger } from '@compass/telemetry';

const STORAGE_KEY = 'compass.lastReload';

export type ReloadReason =
  /** The user tapped the "new version" prompt. */
  | 'update-accepted'
  /** A new version was waiting and the app had been in the background. */
  | 'update-while-hidden'
  | 'error-boundary'
  | 'boot-guard'
  | 'debug-page';

interface ReloadRecord {
  reason: string;
  at: number;
  fromBuild: string | null;
}

export function reloadApp(reason: ReloadReason, fromBuild: string | null = null): void {
  try {
    const record: ReloadRecord = { reason, at: Date.now(), fromBuild };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable: reload anyway, the cause just goes unrecorded */
  }
  window.location.reload();
}

/**
 * Report why the previous page load ended, once. A load with no record is
 * a cold start or a reload the app did not ask for (the user, the
 * WebView, the OS reclaiming memory), which is worth knowing too.
 */
export function reportLastReload(): void {
  let record: ReloadRecord | null = null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    window.sessionStorage.removeItem(STORAGE_KEY);
    if (raw) record = JSON.parse(raw) as ReloadRecord;
  } catch {
    /* ignore */
  }
  const navigation = performance.getEntriesByType?.('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  getLogger().log('info', 'app.boot', {
    action: record?.reason ?? 'unrecorded',
    target: navigation?.type ?? 'unknown',
    data: {
      ...(record ? { fromBuild: record.fromBuild, msAgo: Date.now() - record.at } : {}),
      textScale: measureTextScale(),
      viewportWidth: window.innerWidth,
    },
  });
}

/**
 * How much the device enlarges text beyond what the stylesheet asks for.
 *
 * An Android WebView multiplies every font size by the phone's "font
 * size" setting, and nothing in CSS reports or prevents it: a 16px label
 * is drawn at 20px on a phone set to 1.25. That is how a layout that
 * fits on the designer's screen truncates in the field. Measured by
 * asking for 100px text and seeing how tall the line comes out, and
 * logged at boot so type sizes can be chosen against real devices.
 *
 * 1 means no enlargement. null when it cannot be measured.
 */
export function measureTextScale(): number | null {
  try {
    const probe = document.createElement('span');
    probe.textContent = '0';
    probe.style.cssText =
      'position:absolute;visibility:hidden;font-size:100px;line-height:1;padding:0;border:0';
    document.body.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height > 0 ? Math.round(height) / 100 : null;
  } catch {
    return null;
  }
}

/** How long the app must sit in the background before an update may
 *  reload it unasked. Long enough that a trip to the calculator or the
 *  chat with the supplier is never mistaken for having left. */
export const HIDDEN_BEFORE_AUTO_RELOAD_MS = 5 * 60_000;

/**
 * May a waiting update reload the page without the user asking?
 *
 * Only when nobody is looking and nothing can be lost: the app has been
 * in the background for a while, no sheet is open, no write is in flight
 * and nothing is queued offline. While the app is visible the answer is
 * always no; the user reloads from the prompt when it suits them.
 */
export function mayAutoReload(state: {
  hiddenForMs: number | null;
  openSheets: number;
  mutationsInFlight: number;
  queuedWrites: number;
}): boolean {
  if (state.hiddenForMs === null) return false;
  if (state.hiddenForMs < HIDDEN_BEFORE_AUTO_RELOAD_MS) return false;
  return state.openSheets === 0 && state.mutationsInFlight === 0 && state.queuedWrites === 0;
}
