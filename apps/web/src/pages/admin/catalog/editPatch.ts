/**
 * Review ADM2-24 (2026-11-12): what an edit changed, against what the
 * editor opened with.
 *
 * The supplier and expense template editors sent every field on save,
 * `isArchived` included, as it was when the sheet opened. If another admin
 * archived the record meanwhile, the save restored it without a word, and
 * any field they had changed was put back too. The editors now send only
 * the fields the person changed; archiving and restoring are the row's
 * own buttons.
 */

/** The fields of `next` that differ from `opened` (compared with ===, as sent). */
export function changedFields<T extends Record<string, unknown>>(next: T, opened: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (next[key] !== opened[key]) out[key] = next[key];
  }
  return out;
}

/** Whether `changedFields` found anything to send. */
export function hasChanges(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).length > 0;
}
