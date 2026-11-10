/**
 * UI-11 (review 2026-11): one look for a control that cannot be used —
 * half opacity and a not-allowed cursor. Text fields had no disabled
 * style at all, so a field someone may not edit looked editable and
 * silently did nothing; the other controls used 40, 50 or 60%, and a
 * checkbox or switch with a label dimmed twice (50% × 60%).
 *
 * `disabledClass` styles an element by its own `:disabled` state.
 * `disabledLook` is for a wrapper (a label) whose control is disabled.
 */
export const disabledClass = 'disabled:cursor-not-allowed disabled:opacity-50';
export const disabledLook = 'cursor-not-allowed opacity-50';
