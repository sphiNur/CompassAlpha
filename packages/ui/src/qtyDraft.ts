/**
 * Reads the free-entry field of QtyControl's quick-pick sheet (F13 /
 * ORD-8, 2026-10-30). It used to go through `Number(draft)` and a clamp:
 * an emptied field is `Number('') === 0`, "-3" was clamped up to the
 * minimum, so the confirm button read "Set 0 kg" and tapping it wiped
 * the line. A value the user did not type is never offered now — the
 * button stays disabled and the sheet says why.
 *
 * Expects the field already normalised by NumberInput ("1,5" → "1.5");
 * text that is not one number arrives as typed and is refused here.
 */
export type QtyDraft =
  | { ok: true; value: number }
  | { ok: false; reason: 'empty' | 'notNumber' | 'tooPrecise' | 'belowMin' | 'aboveMax' };

/** The DB keeps order quantities at 3 decimals (numeric(12,3)). */
export const QTY_DECIMALS = 3;

export function readQtyDraft(
  draft: string,
  { min, max }: { min: number; max: number },
): QtyDraft {
  const s = draft.trim();
  if (s === '') return { ok: false, reason: 'empty' };
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
  // The typed value — no longer snapped to the +/- step: with step 1, a
  // typed 0.3 snapped to 0 and wiped the line the same way. M3.35 already
  // made +/- keep off-step values.
  return { ok: true, value: n };
}
