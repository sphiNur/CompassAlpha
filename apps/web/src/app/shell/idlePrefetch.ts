/**
 * Review MWD-04 (modern-web-guidance: schedule-tasks-by-priority): the
 * chunk prefetch is background work. It waited for `requestIdleCallback`,
 * or ran on `setTimeout(0)` where that is missing (iOS WKWebView), so on
 * every iOS start all the warm chunks downloaded at once, beside the start
 * page's own chunk and first queries. Without `requestIdleCallback` it now
 * waits for `load` and a few seconds more, and the chunks go one at a time.
 */

/** What the scheduling needs of `window`; a test passes its own. */
export interface IdleHost {
  requestIdleCallback?: (cb: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
  addEventListener: (type: 'load', cb: () => void, options?: { once?: boolean }) => void;
  removeEventListener: (type: 'load', cb: () => void) => void;
  /** `document.readyState`. */
  readyState: () => DocumentReadyState;
}

/** Without `requestIdleCallback`, how long after `load` the first prefetch waits. */
export const AFTER_LOAD_MS = 3_000;

/**
 * Run `fn` once the browser is idle: on `requestIdleCallback`, or else
 * AFTER_LOAD_MS after the page's `load` event. `afterLoad` false skips the
 * wait for `load` (between two prefetches it is long past). Returns a
 * cancel function.
 */
export function whenIdle(host: IdleHost, fn: () => void, afterLoad = true): () => void {
  const ric = host.requestIdleCallback;
  if (ric) {
    const handle = ric.call(host, fn);
    return () => host.cancelIdleCallback?.call(host, handle);
  }
  let timer: unknown = null;
  const wait = () => {
    timer = host.setTimeout(fn, afterLoad ? AFTER_LOAD_MS : 0);
  };
  if (!afterLoad || host.readyState() === 'complete') {
    wait();
    return () => host.clearTimeout(timer as never);
  }
  host.addEventListener('load', wait, { once: true });
  return () => {
    host.removeEventListener('load', wait);
    if (timer !== null) host.clearTimeout(timer as never);
  };
}

/**
 * Start each task once the browser is idle, the next only after the one
 * before has settled. Returns a cancel function, which stops the tasks
 * not started yet.
 */
export function prefetchInTurn(
  host: IdleHost,
  tasks: ReadonlyArray<() => Promise<unknown>>,
): () => void {
  let cancelled = false;
  let cancelWait: () => void = () => undefined;
  const step = (i: number, first: boolean) => {
    if (cancelled || i >= tasks.length) return;
    cancelWait = whenIdle(
      host,
      () => {
        if (cancelled) return;
        tasks[i]!().then(
          () => step(i + 1, false),
          () => step(i + 1, false),
        );
      },
      first,
    );
  };
  step(0, true);
  return () => {
    cancelled = true;
    cancelWait();
  };
}

/** The browser's own `window` and `document` as an IdleHost. */
export function browserIdleHost(): IdleHost {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  return {
    requestIdleCallback: w.requestIdleCallback?.bind(w),
    cancelIdleCallback: w.cancelIdleCallback?.bind(w),
    setTimeout: (cb, ms) => w.setTimeout(cb, ms),
    clearTimeout: (h) => w.clearTimeout(h),
    addEventListener: (type, cb, options) => w.addEventListener(type, cb, options),
    removeEventListener: (type, cb) => w.removeEventListener(type, cb),
    readyState: () => document.readyState,
  };
}
