import { useRef, useState } from 'react';
import type { ChangeEvent, FocusEvent, InputHTMLAttributes } from 'react';
import { readDecimalText } from './decimalText';

type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * RE-CLS-4 / R2-ORD-1 / R2-CLS-3 (2026-10-31): a decimal field keeps what
 * was typed while it is being typed, and is normalised as a whole.
 *
 * The fields used to rewrite their own text on every keystroke. Typing
 * "1,000" in Chinese passed through "1," — a decimal comma on its own —
 * which became "1.", and the next three zeros landed after the point: a
 * counted 1,000 kg was saved as 1 kg. "12,500.5" became 12.5005 the same
 * way. Pasting worked only because the whole string arrived at once.
 *
 * Now the text on screen is what was typed; the parent's onChange gets
 * the normalised reading of the WHOLE text each time (readDecimalText),
 * or the text itself when it is not one number. On blur a valid entry is
 * shown in its normalised form; an invalid one stays as typed and the
 * field says so (`invalid`), instead of a guess being saved.
 */
export function useDecimalField({
  value,
  onChange,
  onBlur,
}: Pick<InputProps, 'value' | 'onChange' | 'onBlur'>): {
  inputProps: Pick<InputProps, 'value' | 'onChange' | 'onBlur'>;
  /** The text is not one number and the person has left the field. */
  invalid: boolean;
} {
  const [raw, setRaw] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  // What we last handed to the parent. While the parent's value is still
  // that, the typed text is shown; any other value came from outside
  // (a reset, a preset chip) and wins.
  const reported = useRef<string | null>(null);
  const controlled = value !== undefined;
  const external = value === undefined || value === null ? '' : String(value);
  const shown = !controlled
    ? (raw ?? '')
    : raw !== null && external === reported.current
      ? raw
      : external;
  const read = readDecimalText(shown);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const el = event.target;
    const typed = el.value;
    const next = readDecimalText(typed);
    const out = next.ok ? next.value : typed.replace(/[\s\u00a0\u202f]/g, '');
    setRaw(typed);
    reported.current = out;
    if (!onChange) return;
    if (out === typed) {
      onChange(event);
      return;
    }
    // The parent reads `event.target.value`; hand it the normalised text
    // for the duration of the call and put the typed text (and caret)
    // back, so the field never flickers to the rewritten form.
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = out;
    try {
      onChange(event);
    } finally {
      el.value = typed;
      try {
        el.setSelectionRange(start, end);
      } catch {
        // Not every input type supports a selection.
      }
    }
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    setLeft(true);
    // A valid entry now shows as the parent holds it ("1,000" → "1000").
    if (read.ok) setRaw(null);
    onBlur?.(event);
  };

  return {
    inputProps: {
      value: controlled ? shown : undefined,
      onChange: handleChange,
      onBlur: handleBlur,
    },
    invalid: left && !read.ok,
  };
}
