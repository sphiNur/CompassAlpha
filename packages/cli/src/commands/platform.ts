import type { Command } from 'commander';
import kleur from 'kleur';
import { asc, eq } from 'drizzle-orm';
import { closeDb, getDb, schema as s } from '@compass/db';

export function registerPlatformCommands(parent: Command): void {
  parent
    .command('list')
    .description('List platform administrators')
    .action(async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const rows = await db
        .select({
          tgUserId: s.users.tgUserId,
          username: s.users.tgUsername,
          displayName: s.users.displayName,
          createdAt: s.platformAdmins.createdAt,
        })
        .from(s.platformAdmins)
        .innerJoin(s.users, eq(s.users.id, s.platformAdmins.userId))
        .orderBy(asc(s.platformAdmins.createdAt));
      console.table(rows);
      await closeDb();
    });

  parent
    .command('grant <tgUserId>')
    .description('Grant cross-tenant platform administrator access')
    .option('--note <note>', 'Why this person is a platform admin')
    .action(async (tgUserId: string, opts: { note?: string }) => {
      const db = getDb(undefined, { system: 'maintenance' });
      const user = await db.query.users.findFirst({
        where: (u, { eq: eq2 }) => eq2(u.tgUserId, BigInt(tgUserId)),
      });
      if (!user) {
        console.error(`No user with Telegram id ${tgUserId}. They must sign in once first.`);
        await closeDb();
        process.exit(1);
      }
      await db
        .insert(s.platformAdmins)
        .values({ userId: user.id, note: opts.note ?? null })
        .onConflictDoNothing();
      console.log(kleur.green('Platform admin:'), user.displayName, user.tgUserId?.toString());
      await closeDb();
    });

  parent
    .command('revoke <tgUserId>')
    .description('Revoke platform administrator access')
    .action(async (tgUserId: string) => {
      const db = getDb(undefined, { system: 'maintenance' });
      const user = await db.query.users.findFirst({
        where: (u, { eq: eq2 }) => eq2(u.tgUserId, BigInt(tgUserId)),
      });
      if (!user) {
        console.error(`No user with Telegram id ${tgUserId}.`);
        await closeDb();
        process.exit(1);
      }
      const all = await db.select({ userId: s.platformAdmins.userId }).from(s.platformAdmins);
      if (all.length <= 1 && all.some((row) => row.userId === user.id)) {
        console.error('Refusing to remove the last platform administrator.');
        await closeDb();
        process.exit(1);
      }
      await db.delete(s.platformAdmins).where(eq(s.platformAdmins.userId, user.id));
      console.log(kleur.yellow('Revoked platform admin:'), user.displayName);
      await closeDb();
    });
}
