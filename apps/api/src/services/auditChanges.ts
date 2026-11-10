/**
 * ADM2-06 (2026-11-09): what an edit changed, for the admin audit log.
 *
 * The update procedures audited only their input, i.e. the new values:
 * the log could say who edited a product, not that its name went from
 * "Tomato" to "Cherry tomato", nor what its unit or price was before.
 * `auditChanges` keeps `[before, after]` for each listed field the edit
 * sets and actually changes.
 *
 * Pure; tests in __tests__/auditChanges.test.ts.
 */
export type AuditChanges = Record<string, [unknown, unknown]>;

/**
 * `before` is the row as read before the update, `patch` what the update
 * writes. Fields the patch leaves out (or sets to undefined) are not
 * compared. `numeric` fields are decimals that read back padded ("12.50"
 * for "12.5"): they are compared as numbers and kept without the padding.
 * An empty string and null are the same "nothing".
 */
export function auditChanges(
  before: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  numeric: readonly string[] = [],
): AuditChanges {
  const out: AuditChanges = {};
  for (const field of fields) {
    if (patch[field] === undefined) continue;
    const isNumeric = numeric.includes(field);
    const prev = plain(before[field], isNumeric);
    const next = plain(patch[field], isNumeric);
    if (!same(prev, next)) out[field] = [prev, next];
  }
  return out;
}

function plain(value: unknown, numeric: boolean): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (numeric && (typeof value === 'string' || typeof value === 'number')) {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : value;
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return stableJson(a) === stableJson(b);
}

/** JSON with object keys sorted, so `{ru, en}` equals `{en, ru}`. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}
