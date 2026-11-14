import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Review MWA-05 (modern-web-guidance: accessibility, forms): "`disabled`
 * removes the element from the focus order entirely … `aria-disabled`
 * keeps the element focusable", and "DON'T disable submit buttons to
 * block validation; let users submit and highlight errors".
 *
 * A Button that waits for a form (`disabledHint`, UX-05) is aria-disabled
 * now: a tap on it reveals the form's errors, moves to the first missing
 * field and says why. The fields' errors wait for that tap through
 * `useLeftField` (and the number fields through `useDecimalField`), which
 * register here; the Button reveals every field of its scope.
 *
 * The scope is the nearest Sheet (it provides one), else the page's. A
 * Save on a sheet never reveals the page's fields under it.
 */
export interface RevealScope {
  /** Adds a field's reveal; returns what removes it. */
  add(reveal: () => void): () => void;
  /** Shows every registered field's error. */
  revealAll(): void;
}

export function createRevealScope(): RevealScope {
  const reveals = new Set<() => void>();
  return {
    add(reveal) {
      reveals.add(reveal);
      return () => {
        reveals.delete(reveal);
      };
    },
    revealAll() {
      for (const reveal of [...reveals]) reveal();
    },
  };
}

/** The page's scope: fields outside every sheet. */
const pageScope = createRevealScope();

const RevealScopeContext = createContext<RevealScope>(pageScope);

/** A scope of its own (a Sheet's): its Save reveals only its fields. */
export function RevealScopeProvider({ children }: { children: ReactNode }) {
  const [scope] = useState(createRevealScope);
  return <RevealScopeContext.Provider value={scope}>{children}</RevealScopeContext.Provider>;
}

export function useRevealScope(): RevealScope {
  return useContext(RevealScopeContext);
}

/** The part of a control `firstMissingControl` reads; a plain object in tests. */
export interface MissingCandidate {
  getAttribute(name: string): string | null;
  value?: unknown;
  disabled?: boolean;
}

/**
 * Where a blocked Save sends the person: the first control marked
 * invalid (an error is showing), else the first required text field,
 * select or text area that is still empty. Null when neither is there
 * (a missing photo or a store still to pick): the hint alone says why.
 */
export function firstMissingControl<T extends MissingCandidate>(root: {
  querySelectorAll(selector: string): ArrayLike<T>;
}): T | null {
  const usable = (el: T) => !el.disabled && el.getAttribute('aria-hidden') !== 'true';
  for (const el of Array.from(root.querySelectorAll('[aria-invalid="true"]'))) {
    if (usable(el)) return el;
  }
  const required =
    'input[aria-required="true"], textarea[aria-required="true"], select[aria-required="true"], input[required], textarea[required], select[required]';
  for (const el of Array.from(root.querySelectorAll(required))) {
    if (usable(el) && String(el.value ?? '').trim() === '') return el;
  }
  return null;
}
