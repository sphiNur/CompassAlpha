import { useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useRevealScope } from './revealScope';

/**
 * Review MWA-04 (modern-web-guidance: validate-input-after-interaction):
 * "DON'T trigger validation errors … on every keystroke while the user is
 * typing (validate on submit or `blur`, and clear errors on `input` once
 * resolved)."
 *
 * Whether a field's error may show: once the person has left the field
 * (`onBlur`) or tried to save (`reveal`). From then on the error follows
 * the value, so it goes as soon as the value is valid. The kit's number
 * fields already wait like this (useDecimalField's `left`).
 *
 * `inputProps` also counts Enter (the keyboard's done / go) as leaving:
 * on a phone, tapping a disabled Save does not always take focus off the
 * field, but the keyboard's own key does submit-like work.
 *
 * `resetKey`: when it changes (a sheet opened again, another row being
 * edited) the field counts as not left yet.
 *
 * Review MWA-05 (modern-web-guidance: forms): a tap on a Save that waits
 * for the form (Button `disabledHint`) reveals this field too, through
 * the nearest reveal scope (revealScope.tsx); pages need not call
 * `reveal` from their Save.
 */
export function useLeftField(resetKey?: unknown): {
  left: boolean;
  onBlur: () => void;
  reveal: () => void;
  inputProps: { onBlur: () => void; onKeyDown: (e: KeyboardEvent<HTMLElement>) => void };
} {
  const [state, setState] = useState<{ key: unknown; left: boolean }>(() => ({
    key: resetKey,
    left: false,
  }));
  // Adjusted while rendering (React's "reset state when a prop changes"),
  // so the first render after the key changes already reads `false`.
  const current = nextLeftState(state, resetKey);
  if (current !== state) setState(current);
  const mark = useCallback(() => setState({ key: resetKey, left: true }), [resetKey]);
  const scope = useRevealScope();
  useEffect(() => scope.add(mark), [scope, mark]);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (revealsOnKey(e.key, e.nativeEvent.isComposing)) mark();
    },
    [mark],
  );
  return {
    left: current.left,
    onBlur: mark,
    reveal: mark,
    inputProps: { onBlur: mark, onKeyDown },
  };
}

/** The state for `key`: the same object while the key holds, a fresh one after. */
export function nextLeftState<S extends { key: unknown; left: boolean }>(
  state: S,
  key: unknown,
): S | { key: unknown; left: false } {
  return Object.is(state.key, key) ? state : { key, left: false };
}

/** A field's error as shown: only once the field may show it. */
export function shownError<T>(error: T | null | undefined, left: boolean): T | null {
  return left && error !== undefined && error !== null ? error : null;
}

/** Enter shows the error, but not while an IME is composing (pinyin). */
export function revealsOnKey(key: string, isComposing: boolean): boolean {
  return key === 'Enter' && !isComposing;
}
