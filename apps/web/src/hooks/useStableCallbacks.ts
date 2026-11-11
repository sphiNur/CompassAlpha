/**
 * Handlers that keep their identity, for a child wrapped in memo()
 * (review RUNWEB1-07).
 *
 * memo() skips a child only when every prop is the same as last time. A
 * parent that writes its handlers inline hands over new functions on
 * each render, so the child draws again anyway: RunPage did that to the
 * whole purchase list on every keystroke in its sheets.
 *
 * Each handler is swapped for a stand-in made once per component that
 * calls the handler from the latest committed render. An absent handler
 * stays absent (a child may read that as "not offered here"), so its
 * stand-in comes and goes with it.
 *
 * Only for handlers that run on events or in effects. The latest ones are
 * taken in when a render commits, so a call made while rendering would
 * reach the previous one: a function a child calls to draw (a formatter,
 * a name lookup) stays an ordinary prop.
 */
import { useLayoutEffect, useRef, useState } from 'react';

// `never[]`: every handler signature fits.
type Handler = (...args: never[]) => unknown;
type Handlers = Record<string, Handler | undefined>;

/** A stand-in per key, each calling that key's handler in `read()`. Exported for tests. */
export function makeStandIns<T extends Handlers>(
  keys: ReadonlyArray<keyof T>,
  read: () => T,
): Partial<Record<keyof T, Handler>> {
  const out: Partial<Record<keyof T, Handler>> = {};
  for (const key of keys) out[key] = (...args) => read()[key]?.(...args);
  return out;
}

/**
 * `handlers` with each one present swapped for its stand-in. A key with
 * no stand-in keeps its own handler: drawn more often, never wrong.
 * Exported for tests.
 */
export function withStandIns<T extends Handlers>(
  handlers: T,
  standIns: Partial<Record<keyof T, Handler>>,
): T {
  const out: Partial<Record<keyof T, Handler>> = {};
  for (const key of Object.keys(handlers) as Array<keyof T>) {
    const handler = handlers[key];
    out[key] = handler ? (standIns[key] ?? handler) : undefined;
  }
  return out as T;
}

export function useStableCallbacks<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  // A call site names the same handlers on every render.
  const [standIns] = useState(() =>
    makeStandIns(Object.keys(handlers) as Array<keyof T>, () => latest.current),
  );
  return withStandIns(handlers, standIns);
}
