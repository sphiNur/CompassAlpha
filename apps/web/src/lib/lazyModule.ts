/**
 * A lazily imported module that remembers itself once it is in (owner,
 * 2026-11-15: "pages flash when they open"). React.lazy suspends on the
 * first render of a lazy component even when its chunk was downloaded
 * long before (idle prefetch, main.tsx), so the first visit to every tab
 * drew the loading spinner for a frame, in the middle of the tab's slide.
 * resilientLazy (components/resilientLazy.tsx) reads `loaded()` and renders
 * a module that is already in directly, without suspending.
 *
 * The same function is the importer everywhere (React.lazy, the prefetch,
 * main.tsx), so whichever of them brings the chunk in, all see it.
 */
export type LazyModule<T> = (() => Promise<T>) & { loaded: () => T | undefined };

export function lazyModule<T>(load: () => Promise<T>): LazyModule<T> {
  let value: T | undefined;
  let pending: Promise<T> | null = null;
  const get = () => {
    pending ??= load().then(
      (m) => {
        value = m;
        return m;
      },
      (error: unknown) => {
        // A failed import may succeed later (back online): try again then.
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  return Object.assign(get, { loaded: () => value });
}
