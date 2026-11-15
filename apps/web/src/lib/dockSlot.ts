/**
 * The dock's tool slot (UI overhaul C, 2026-11-15): Shell puts an element
 * on the dock's row, between the nav and the main button, and a page draws
 * its tool there through a portal (components/dock). The page keeps its
 * own state and handlers; the dock only gives the place.
 */
import { useSyncExternalStore } from 'react';

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setDockToolSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDockToolSlot(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => slot,
    () => null,
  );
}
