/**
 * DX-VIS-15 (2026-11-01): a field that is wrong only because nothing has
 * been typed yet is not marked red. A new daily-close expense opened with
 * a red amount field and a red reason box before the person did anything.
 * A field shows its problem once it has been left (blur) or once a save
 * was tried; the save button still counts it either way.
 */
export function showFieldError(
  invalid: boolean,
  touched: ReadonlySet<string>,
  key: string,
  saveTried: boolean,
): boolean {
  return invalid && (saveTried || touched.has(key));
}

/** The set with `key` added, or the same set when it was already there. */
export function withTouched(touched: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (touched.has(key)) return touched;
  const next = new Set(touched);
  next.add(key);
  return next;
}
