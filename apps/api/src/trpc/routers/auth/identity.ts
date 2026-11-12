/**
 * Who is signing in: the Telegram account behind a Mini App's initData,
 * that account's user row, and which of the person's memberships a
 * sign-in opens.
 *
 * Review COREAPI-09 (2026-11-12): Telegram sign-in and invite acceptance
 * each verified initData and wrote the user row their own way, and three
 * sign-in paths each picked the membership.
 */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import type { Locale } from '@compass/i18n';
import { env } from '../../../env';
import { verifyInitData, type TelegramUser } from '../../../services/telegramAuth';
import { isDevMockLoginAvailable } from './modes';

type UserRow = typeof s.users.$inferSelect;

/** The initData the local developer mock sends instead of Telegram's (modes.ts). */
const DEV_MOCK_INIT_DATA = '1';
const DEV_MOCK_TG_USER: TelegramUser = {
  id: 9_000_000_001,
  first_name: 'Local Developer',
  username: 'compass_local_dev',
  language_code: 'en',
};

/**
 * The Telegram account `initData` vouches for. The local developer mock
 * stands in for one where the server allows it; anything else must carry
 * Telegram's signature for this bot.
 */
export function telegramUserOf(initData: string): { tg: TelegramUser; isDevMock: boolean } {
  if (initData === DEV_MOCK_INIT_DATA && isDevMockLoginAvailable()) {
    return { tg: DEV_MOCK_TG_USER, isDevMock: true };
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'auth.errors.botTokenMissing',
    });
  }
  const verified = verifyInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok || !verified.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidInitData' });
  }
  return { tg: verified.user, isDevMock: false };
}

/** The name Telegram shows for this person: their first and last name, else their username. */
function telegramName(tg: TelegramUser): string {
  return [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || '';
}

/** The user row of this Telegram account, if it has one. */
export function findTelegramUser(tx: DB, tg: TelegramUser): Promise<UserRow | undefined> {
  return tx.query.users.findFirst({
    where: (u, { eq: eq2 }) => eq2(u.tgUserId, BigInt(tg.id)),
  });
}

/** A user row for a Telegram account seen for the first time, named as Telegram names them. */
export async function createTelegramUser(
  tx: DB,
  tg: TelegramUser,
  row: { locale: Locale; displayNameLocked: boolean },
): Promise<UserRow> {
  const [created] = await tx
    .insert(s.users)
    .values({
      tgUserId: BigInt(tg.id),
      tgUsername: tg.username ?? null,
      displayName: telegramName(tg) || `user-${tg.id}`,
      avatarUrl: tg.photo_url ?? null,
      locale: row.locale,
      displayNameLocked: row.displayNameLocked,
    })
    .returning();
  if (!created) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
  return created;
}

/**
 * A known user's row brought up to date with what Telegram says now: their
 * username and photo, the language the caller settled on, and when they
 * were last seen. With `adoptName`, a placeholder name (`tg:<id>`, left by
 * an admin's invite by Telegram ID) becomes Telegram's.
 */
export async function touchTelegramUser(
  tx: DB,
  known: UserRow,
  tg: TelegramUser,
  update: { locale: Locale; adoptName?: boolean },
): Promise<void> {
  await tx
    .update(s.users)
    .set({
      tgUsername: tg.username ?? known.tgUsername,
      avatarUrl: tg.photo_url ?? known.avatarUrl,
      locale: update.locale,
      lastSeenAt: new Date(),
      ...(update.adoptName && known.displayName.startsWith('tg:')
        ? { displayName: telegramName(tg) || known.displayName }
        : {}),
    })
    .where(eq(s.users.id, known.id));
}

/**
 * The membership a sign-in opens: the organisation the person was last in,
 * while they are still active there; otherwise the first one they joined.
 * Review COREAPI-34 (2026-11-12): the fallback was any active membership,
 * in whatever order Postgres returned them, so someone in several
 * organisations could land in a different one at each sign-in. The
 * workspace switcher lists them by when they joined, too.
 */
export async function pickActiveMember(tx: DB, user: Pick<UserRow, 'id' | 'lastOrgId'>) {
  const lastOrgId = user.lastOrgId;
  if (lastOrgId) {
    const remembered = await tx.query.members.findFirst({
      where: (m, { eq: eq2, and: and2 }) =>
        and2(eq2(m.userId, user.id), eq2(m.orgId, lastOrgId), eq2(m.status, 'active')),
    });
    if (remembered) return remembered;
  }
  return tx.query.members.findFirst({
    where: (m, { eq: eq2, and: and2 }) => and2(eq2(m.userId, user.id), eq2(m.status, 'active')),
    orderBy: (m, { asc }) => [asc(m.joinedAt)],
  });
}
