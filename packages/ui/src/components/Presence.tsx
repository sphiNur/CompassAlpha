import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { REVEAL_MS } from './Reveal';

/**
 * A list whose rows the person adds and removes (the daily close's wages
 * and expenses), with the rows coming and going in motion (owner
 * 2026-11-16). Rows there when the list first draws do not animate, so a
 * page never fades in row by row; a row added later slides and fades in
 * (.app-reveal, tokens.css), and a removed one stays REVEAL_MS, inert and
 * hidden from assistive tech, folding away where it was. Nothing under
 * reduced motion.
 */
export type PresencePhase = 'stay' | 'enter' | 'leave';

export interface PresenceEntry<T> {
  item: T;
  key: string;
  phase: PresencePhase;
  /** The item's index among the live items (a leaving one keeps its last). */
  index: number;
}

interface Leaving<T> {
  item: T;
  index: number;
}

export function usePresence<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): PresenceEntry<T>[] {
  const firstKeys = useRef<Set<string> | null>(null);
  if (firstKeys.current === null) firstKeys.current = new Set(items.map(keyOf));
  const [prevItems, setPrevItems] = useState(items);
  const [leaving, setLeaving] = useState<ReadonlyMap<string, Leaving<T>>>(new Map());
  // State from the previous render, so a removed row is never missing for
  // a frame before it starts to leave.
  if (prevItems !== items) {
    const now = new Set(items.map(keyOf));
    const next = new Map(leaving);
    for (const key of now) next.delete(key);
    if (!prefersReducedMotion()) {
      prevItems.forEach((item, index) => {
        const key = keyOf(item);
        if (!now.has(key)) next.set(key, { item, index });
      });
    }
    setPrevItems(items);
    setLeaving(next);
  }
  const leavingKeys = [...leaving.keys()].join('\u0000');
  useEffect(() => {
    if (!leavingKeys) return;
    const timer = setTimeout(() => setLeaving(new Map()), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [leavingKeys]);

  const out: PresenceEntry<T>[] = items.map((item, index) => {
    const key = keyOf(item);
    return { item, key, index, phase: firstKeys.current!.has(key) ? 'stay' : 'enter' };
  });
  // Each leaving row goes back where it was.
  [...leaving.entries()]
    .sort((a, b) => a[1].index - b[1].index)
    .forEach(([key, { item, index }]) => {
      out.splice(Math.min(index, out.length), 0, { item, key, index, phase: 'leave' });
    });
  return out;
}

/** One row of a usePresence list: the wrapper that animates it. */
export function PresenceItem({ phase, children }: { phase: PresencePhase; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // React 18 has no `inert` prop.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (phase === 'leave') el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [phase]);
  return (
    <div
      ref={ref}
      data-presence={phase}
      data-closing={phase === 'leave' ? '' : undefined}
      aria-hidden={phase === 'leave' || undefined}
      className={phase === 'stay' ? undefined : 'app-reveal'}
    >
      {children}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
