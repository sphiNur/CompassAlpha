/**
 * Review NEW-07 (2026-11-12): the sort position of a category, product or
 * expense template, as its editor holds it.
 *
 * The editors kept a number and read the field with `Number(text) || 0`
 * on every keystroke. A typed "-" was not a number, so the field went
 * straight back to 0 and no negative position could be entered, though
 * the server takes them; an emptied field saved 0 and "1.5" saved 1,
 * without a word. The editors now keep the text and read it here, with
 * the server's rule (SORT_INDEX_RANGE, SortIndexSchema).
 */
import { SORT_INDEX_RANGE, wholeNumberIn } from '@compass/contracts/limits';

/** The sort position the text holds, or null while it is not one. */
export function readSortIndex(text: string): number | null {
  return wholeNumberIn(text.trim(), SORT_INDEX_RANGE);
}
