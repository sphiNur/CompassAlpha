import { useCallback, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * A11Y-15 (2026-10-31): keyboard behaviour of a radio group (ChipBar's
 * radio variant, PickerGroup) as WAI-ARIA describes it: the group is one
 * Tab stop — the checked radio, or the first one when none is checked —
 * and the arrow keys move between its radios (Home / End jump to the
 * ends). Before this every chip was its own Tab stop (seven category
 * chips to get past on the order page) and arrows did nothing.
 *
 * Radios render `tabIndex={checked ? 0 : -1}` themselves; this hook
 * makes the first radio the stop when nothing is checked, and handles
 * the keys. `followFocus` also checks the radio focus lands on (a filter
 * strip); leave it off where choosing does real work (a delivery status
 * that sends a request) so arrows only move and Space / Enter chooses.
 */
export function nextRadioIndex(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The radio that is the group's one Tab stop: the checked one, or the
 * first when none is checked; -1 for an empty group.
 */
export function rovingStopIndex(checked: readonly boolean[]): number {
  const index = checked.indexOf(true);
  return index >= 0 ? index : checked.length > 0 ? 0 : -1;
}

function radiosIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="radio"]')].filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
}

export function useRovingRadio<T extends HTMLElement>({ followFocus }: { followFocus: boolean }) {
  const ref = useRef<T>(null);

  // No dependency list on purpose: the radios inside may change on any
  // render of the group (options load, the checked one moves).
  //
  // Review UI-07 (2026-11-11): sets every radio, not only the first. The
  // first radio kept the 0 it was given while nothing was checked once
  // another one was checked — React leaves an attribute alone while its
  // prop does not change — so the group had two Tab stops.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const radios = radiosIn(root);
    const stop = rovingStopIndex(radios.map((r) => r.getAttribute('aria-checked') === 'true'));
    radios.forEach((radio, index) => {
      radio.tabIndex = index === stop ? 0 : -1;
    });
  });

  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      const root = ref.current;
      if (!root) return;
      const radios = radiosIn(root);
      const current = radios.indexOf(document.activeElement as HTMLElement);
      if (current < 0) return;
      const next = nextRadioIndex(radios.length, current, event.key);
      if (next === null) return;
      event.preventDefault();
      const target = radios[next]!;
      target.focus();
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      if (followFocus) target.click();
    },
    [followFocus],
  );

  return { ref, onKeyDown };
}
