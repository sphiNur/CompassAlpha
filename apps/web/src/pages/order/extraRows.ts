/**
 * The rules for an order's off-catalog lines ("other items"), apart from
 * the editor on the order page that shows them (ORD-13, 2026-11-11).
 */
import type { CanonicalUnit } from '@compass/contracts';
import {
  ORDER_QTY_MAX,
  WHOLE_NUMBER_UNITS,
  isCanonicalUnit,
  isPositiveQty,
} from '@compass/contracts/limits';

export interface ExtraDraft {
  name: string;
  qty: string;
  /**
   * As the server has it. A row saved before M3.34 (2026-05-19) may carry
   * free text such as "kgs" or "公斤": it is shown as written, where it
   * used to become 'kg' (and re-saving made that true).
   */
  unit: string;
  note?: string;
}

/** A row as it is sent: its unit is one CanonicalUnitSchema accepts. */
export type ExtraLine = Omit<ExtraDraft, 'unit'> & { unit: CanonicalUnit };

/**
 * The rows worth showing or sending: named, with a quantity the server
 * takes, trimmed. The server enforces the same rules; this just doesn't
 * fire a guaranteed-reject request for in-progress UI state. The unit is
 * not checked: a list shows one from before M3.34 as written.
 */
export function cleanExtraRows(draft: readonly ExtraDraft[]): ExtraDraft[] {
  const out: ExtraDraft[] = [];
  for (const r of draft) {
    const name = r.name.trim();
    const qty = r.qty.trim();
    if (!name) continue;
    if (!isPositiveQty(qty)) continue;
    const note = r.note?.trim();
    out.push({ name, qty, unit: r.unit, ...(note ? { note } : {}) });
  }
  return out;
}

/**
 * What a save sends, or null while it has to wait: a row with a unit from
 * before M3.34 can be neither sent (the server refuses it) nor left out
 * (that deletes it), so nothing is saved until it has one from the list.
 * DX-ORD-13: "1.5 个" is not sent either; the row says why. (Only here:
 * rows saved like that before still show on receipts.)
 */
export function extraLinesToSave(draft: readonly ExtraDraft[]): ExtraLine[] | null {
  if (draft.some(unlistedUnit)) return null;
  return cleanExtraRows(draft).flatMap((r): ExtraLine[] =>
    isCanonicalUnit(r.unit) && !wholeNumberRequired(r) ? [{ ...r, unit: r.unit }] : [],
  );
}

/** A named row whose unit is not on the list (saved before M3.34). */
export function unlistedUnit(row: ExtraDraft): boolean {
  return row.name.trim() !== '' && !isCanonicalUnit(row.unit);
}

/**
 * A named row that cannot be saved as it stands: its qty, or its unit.
 * Blank-name rows are just "not filled in yet" and aren't flagged.
 * 2026-10-21 audit CA-27 (B-09).
 */
export function isInvalidExtraRow(row: ExtraDraft): boolean {
  return unlistedUnit(row) || (row.name.trim() !== '' && badExtraQty(row));
}

/** A qty cleanExtraRows would drop (empty, malformed or ≤ 0), or one the unit refuses. */
export function badExtraQty(row: ExtraDraft): boolean {
  const qty = row.qty.trim();
  // ORD-9: the server's upper bound too, so the row is flagged before save.
  return !isPositiveQty(qty) || Number(qty) > ORDER_QTY_MAX || wholeNumberRequired(row);
}

/** DX-ORD-13: a whole-number unit (个, 包, 箱 …) with a fractional qty. */
export function wholeNumberRequired(row: ExtraDraft): boolean {
  const qty = Number(row.qty.trim());
  return WHOLE_NUMBER_UNITS.has(row.unit) && Number.isFinite(qty) && !Number.isInteger(qty);
}

/**
 * The name suggestions worth offering while `typed` is in the name field:
 * not the name already typed. Review ORD-24 (2026-11): suggestions come
 * back as people last wrote them (ORD-17), grouped without case, so they
 * are compared without case too; "Lauk" was still offered under "Lauk".
 */
export function otherSuggestions<T extends { name: string }>(
  suggestions: readonly T[],
  typed: string,
): T[] {
  const own = typed.trim().toLowerCase();
  return suggestions.filter((s) => s.name.length > 0 && s.name.toLowerCase() !== own);
}
