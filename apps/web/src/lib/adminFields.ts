/**
 * Rules for the typed fields of the admin sheets, kept pure so they can
 * be tested without rendering.
 */

/**
 * DX-ADM-4 (2026-11-01): a role's rank is a whole number from 1 to `max`
 * (one below the actor's own rank). The field used to clamp on every
 * keystroke: clearing it gave 1, typing 45 gave 99, and 12.7 got through
 * to a bare "something went wrong". The text is now kept as typed and
 * read here when the field loses focus and on save.
 */
export type RankResult = { ok: true; rank: number } | { ok: false; max: number };

export function readRank(text: string, max: number): RankResult {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return { ok: false, max };
  const rank = Number(t);
  return rank >= 1 && rank <= max ? { ok: true, rank } : { ok: false, max };
}

/**
 * DX-ADM-4: a new role starts one tier below the actor, and never at or
 * above the built-in admin tier: a super admin (100) was offered 90,
 * above admin (80).
 */
export function defaultNewRoleRank(myMaxRank: number, adminRank: number): number {
  return Math.max(1, Math.min(myMaxRank, adminRank) - 10);
}

/**
 * DX-ADM-5 (2026-11-01): a Telegram id is 4–15 digits. The field used to
 * delete everything else, so a pasted phone number "+998 90 123" became
 * the id 99890123 and created someone who does not exist. `notDigits`
 * is wrong as soon as it is typed; `length` only once the person is done.
 */
export function tgIdProblem(text: string): null | 'notDigits' | 'length' {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return 'notDigits';
  return t.length >= 4 && t.length <= 15 ? null : 'length';
}

/**
 * DX-ADM-4: a role's identifier is lowercase letters, digits and hyphens.
 * Spaces and underscores become hyphens as they are typed ("Night Shift"
 * → "night-shift"); anything else stays so the field can say what is
 * wrong instead of a silently grey button.
 */
export function normaliseSlugInput(text: string): string {
  return text.toLowerCase().replace(/[\s_]+/g, '-');
}

export function slugIsValid(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}
