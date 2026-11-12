/**
 * An id the client gives a record it creates (a run expense, a daily
 * close's expense or wage line), so a save that is sent again names the
 * same record. Review RUNWEB1-04 (2026-11-12): the purchase page and the
 * daily close each had a copy.
 */
export function newClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
