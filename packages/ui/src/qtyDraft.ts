import { readDecimalText } from './decimalText';

/**
 * Reads the free-entry field of QtyControl's quick-pick sheet (F13 /
 * ORD-8, 2026-10-30). It used to go through `Number(draft)` and a clamp:
 * an emptied field is `Number('') === 0`, "-3" was clamped up to the
 * minimum, so the confirm button read "Set 0 kg" and tapping it wiped
 * the line. A value the user did not type is never offered now — the
 * button stays disabled and the sheet says why.
 *
 * UX-17 (2026-11-14): the text goes through readDecimalText here too, so a
 * ru / uz decimal comma ("1,5") is read the same as in every other number
 * field even when the caller hands over the raw typed text. Text that is
 * not one number is refused, never guessed.
 */
export type QtyDraft =
  | { ok: true; value: number }
  | {
      ok: false;
      reason: 'empty' | 'notNumber' | 'tooPrecise' | 'belowMin' | 'aboveMax' | 'notMultiple';
    };

/** The DB keeps order quantities at 3 decimals (numeric(12,3)). */
export const QTY_DECIMALS = 3;

/**
 * Is `n` a whole number of `step`s? The server refuses an order line that
 * is not. Both have at most 3 decimals, so they are compared in
 * thousandths. No step (or 0) accepts anything.
 */
export function isMultipleOfStep(n: number, step: number | undefined): boolean {
  if (step === undefined || !(step > 0)) return true;
  const scaledStep = Math.round(step * 10 ** QTY_DECIMALS);
  return scaledStep <= 0 || Math.round(n * 10 ** QTY_DECIMALS) % scaledStep === 0;
}

export function readQtyDraft(
  draft: string,
  { min, max, step }: { min: number; max: number; step?: number },
): QtyDraft {
  if (draft.trim() === '') return { ok: false, reason: 'empty' };
  const read = readDecimalText(draft);
  if (!read.ok) return { ok: false, reason: 'notNumber' };
  const s = read.value;
  // Number() accepts '0x10', '1e3' and ' '; a quantity field should not.
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, reason: 'notNumber' };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, reason: 'notNumber' };
  if (n < min) return { ok: false, reason: 'belowMin' };
  if (n > max) return { ok: false, reason: 'aboveMax' };
  // R2-ORD-2 (2026-10-31): a 4th decimal was rounded away, so "0.0004"
  // offered "Set 0" and tapping it wiped the line. Say how many decimals
  // the quantity keeps instead.
  const fraction = s.includes('.') ? s.slice(s.indexOf('.') + 1).replace(/0+$/, '') : '';
  if (fraction.length > QTY_DECIMALS) return { ok: false, reason: 'tooPrecise' };
  // CMP-ORD-1 (2026-10-31): the server refuses an order line that is not a
  // multiple of the product's step, and the toast then lost the step
  // ("must be a multiple of  "). Refuse it here with the reason instead.
  if (!isMultipleOfStep(n, step)) return { ok: false, reason: 'notMultiple' };
  // The typed value — never snapped to the step: with step 1, a typed 0.3
  // snapped to 0 and wiped the line the same way.
  return { ok: true, value: n };
}
