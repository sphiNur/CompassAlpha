import { useEffect, type RefObject } from 'react';
import { scrollBehavior } from '../lib/reducedMotion';

/**
 * Scrolls `ref` into view, by as little as it takes, each time `key`
 * changes.
 *
 * Review ATT-06 (2026-11-12): on a short screen, or on a phone held
 * sideways, the face check's prompt ended up below the visible part of its
 * sheet, and nobody scrolls while blinking or turning their head.
 */
export function useKeepInView(ref: RefObject<HTMLElement | null>, key: unknown): void {
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  }, [ref, key]);
}
