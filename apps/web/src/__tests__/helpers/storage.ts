/**
 * Stand-ins for localStorage / sessionStorage (review TEST3-05, 2026-11).
 * Each test file wrote its own copies, some word for word.
 */

/** An in-memory Storage holding `items`; `map` is its contents, for a test to look into. */
export function memoryStorage(items: Record<string, string> = {}) {
  const map = new Map(Object.entries(items));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
  };
}

/** A Storage whose every call throws, as a blocked or full one does in some WebViews. */
export function throwingStorage() {
  const blocked = (): never => {
    throw new Error('SecurityError');
  };
  return {
    getItem: blocked,
    setItem: blocked,
    removeItem: blocked,
    clear: blocked,
    get length(): number {
      return blocked();
    },
    key: blocked,
  };
}
