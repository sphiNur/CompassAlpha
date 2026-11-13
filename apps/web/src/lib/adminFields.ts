/**
 * Rules for the typed fields of the admin sheets, kept pure so they can
 * be tested without rendering. The rules the server checks too come from
 * the contracts (review ADM1-26).
 */
import { SLUG_RE, TG_USER_ID_RE } from '@compass/contracts/limits';

/**
 * DX-ADM-4 (2026-11-01): a role's rank is a whole number from `min`
 * (1 unless the role's tier is locked, roleRankRange) to `max` (one below
 * the actor's own rank). The field used to clamp on every keystroke:
 * clearing it gave 1, typing 45 gave 99, and 12.7 got through to a bare
 * "something went wrong". The text is now kept as typed and read here
 * when the field loses focus and on save.
 */
export type RankResult = { ok: true; rank: number } | { ok: false; max: number };

export function readRank(text: string, max: number, min = 1): RankResult {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return { ok: false, max };
  const rank = Number(t);
  return rank >= min && rank <= max ? { ok: true, rank } : { ok: false, max };
}

/**
 * ADM1-02 (2026-11-09): the levels a custom role may move to. A role
 * somebody holds keeps its tier, because the tier decides where it is
 * bound (from `adminRank` up for the whole workspace, below it per
 * store); the server refuses the rest (rankTierChangeHasBindings).
 * `locked` says the range was narrowed for that reason.
 */
export function roleRankRange(
  current: number,
  held: boolean,
  actorRank: number,
  adminRank: number,
): { min: number; max: number; locked: boolean } {
  const max = actorRank - 1;
  if (!held) return { min: 1, max, locked: false };
  return current >= adminRank
    ? { min: adminRank, max, locked: true }
    : { min: 1, max: Math.min(max, adminRank - 1), locked: max >= adminRank };
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
 * The whole rule is the server's (TG_USER_ID_RE).
 */
export function tgIdProblem(text: string): null | 'notDigits' | 'length' {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return 'notDigits';
  return TG_USER_ID_RE.test(t) ? null : 'length';
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
  return SLUG_RE.test(slug);
}

/** Cyrillic letters (Russian and Uzbek) in Latin, for a code made from a name. */
const CYRILLIC_LETTERS = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяўқғҳ'; // i18n-exempt: transliteration table
const LATIN_FOR_CYRILLIC =
  'a b v g d e yo zh z i y k l m n o p r s t u f kh ts ch sh sch _ y _ e yu ya o q g h'.split(' ');
const CYRILLIC_TO_LATIN: Record<string, string> = Object.fromEntries(
  [...CYRILLIC_LETTERS].map((ch, i) => [ch, LATIN_FOR_CYRILLIC[i]!.replace('_', '')]),
);

/** Longest code made from a name; a hand-typed one may be longer. */
const CODE_FROM_NAME_MAX = 32;

/**
 * D2 (2026-11-13): the short code of a category or a role, made from its
 * name when the field is left empty. The first name that has Latin or
 * Cyrillic letters gives it ("Night shift" → "night-shift", "Молочные
 * продукты" → "molochnye-produkty"); a name with neither (Chinese) gives
 * `fallback`. A code already in `taken` gets a number: "dairy-2".
 * The field stays editable for those who want their own.
 */
export function codeFromName(
  names: ReadonlyArray<string | null | undefined>,
  taken: ReadonlySet<string>,
  fallback: string,
): string {
  let base = '';
  for (const name of names) {
    if (!name) continue;
    const latin = [...name.normalize('NFKD').toLowerCase()]
      .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
      .join('')
      .replace(/[̀-ͯʻʼ'’`]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, CODE_FROM_NAME_MAX)
      .replace(/^-+|-+$/g, '');
    if (/[a-z]/.test(latin)) {
      base = latin;
      break;
    }
  }
  if (!base) base = fallback;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const code = `${base}-${n}`;
    if (!taken.has(code)) return code;
  }
}

/**
 * D5 (2026-11-13): the role an invite starts with. An invite without a
 * role left the person on "You can't use Compass yet", so the form always
 * has one: staff when it may be given, else the lowest store role on
 * offer, else the lowest role. On the organisation-level list the lowest
 * organisation role comes first. `roles` are those the inviter may give.
 */
export function defaultInviteRole(
  roles: ReadonlyArray<{ slug: string; rank: number }>,
  preferOrgTier: boolean,
  adminRank: number,
): string {
  const lowest = (list: ReadonlyArray<{ slug: string; rank: number }>) =>
    list.reduce<{ slug: string; rank: number } | null>(
      (best, r) => (best === null || r.rank < best.rank ? r : best),
      null,
    )?.slug ?? null;
  const orgTier = roles.filter((r) => r.rank >= adminRank);
  const storeTier = roles.filter((r) => r.rank < adminRank);
  if (preferOrgTier && orgTier.length > 0) return lowest(orgTier)!;
  if (storeTier.some((r) => r.slug === 'staff')) return 'staff';
  return lowest(storeTier) ?? lowest(roles) ?? '';
}
