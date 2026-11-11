/**
 * Members' names and avatars, by member id (review ORD-06: the order
 * router looked them up four times with the same join).
 */
import { eq, inArray } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';

export interface MemberProfile {
  displayName: string;
  avatarUrl: string | null;
}

/** The profiles of `memberIds` (empty and repeated ids are ignored). */
export async function memberProfiles(
  db: DB,
  memberIds: Iterable<string | null | undefined>,
): Promise<Map<string, MemberProfile>> {
  const ids = [...new Set([...memberIds].filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      memberId: s.members.id,
      displayName: s.users.displayName,
      avatarUrl: s.users.avatarUrl,
    })
    .from(s.members)
    .innerJoin(s.users, eq(s.users.id, s.members.userId))
    .where(inArray(s.members.id, ids));
  return new Map(
    rows.map((r) => [r.memberId, { displayName: r.displayName, avatarUrl: r.avatarUrl }]),
  );
}
