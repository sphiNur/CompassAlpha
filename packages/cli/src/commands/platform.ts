import type { Command } from 'commander';
import kleur from 'kleur';
import { asc, eq, sql } from 'drizzle-orm';
import { schema as s } from '@compass/db';
import { withMaintenanceDb } from '../db';
import { parseTgUserId, Refusal } from '../refusal';

export function registerPlatformCommands(parent: Command): void {
  parent
    .command('list')
    .description('List platform administrators')
    .action(() =>
      withMaintenanceDb(async (db) => {
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
      }),
    );

  parent
    .command('grant <tgUserId>')
    .description('Grant cross-tenant platform administrator access')
    .option('--note <note>', 'Why this person is a platform admin')
    .action(async (raw: string, opts: { note?: string }) => {
      const tgUserId = parseTgUserId(raw);
      await withMaintenanceDb(async (db) => {
        const user = await db.query.users.findFirst({
          where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
        });
        // Signing in does not create an account (auth.telegramLogin turns
        // an unknown id away); an invite or `compass user grant` does.
        if (!user) {
          throw new Refusal(
            `No account has Telegram id ${raw}. Invite them to an organization first.`,
          );
        }
        const [added] = await db
          .insert(s.platformAdmins)
          .values({ userId: user.id, note: opts.note ?? null })
          .onConflictDoNothing()
          .returning({ userId: s.platformAdmins.userId });
        console.log(
          kleur.green(added ? 'Platform admin:' : 'Already a platform admin:'),
          user.displayName,
          raw,
        );
      });
    });

  parent
    .command('revoke <tgUserId>')
    .description('Revoke platform administrator access')
    .action(async (raw: string) => {
      const tgUserId = parseTgUserId(raw);
      const user = await withMaintenanceDb((db) =>
        db.transaction(async (tx) => {
          // Review OPS-41 (2026-11): the count and the delete were separate
          // statements, so two revokes at once could each see the other
          // administrator and remove both. This lock conflicts with itself:
          // a second revoke waits here until the first commits, then counts
          // again. It needs no privilege beyond the DELETE below.
          await tx.execute(sql`LOCK TABLE ${s.platformAdmins} IN SHARE ROW EXCLUSIVE MODE`);
          const found = await tx.query.users.findFirst({
            where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
          });
          if (!found) throw new Refusal(`No account has Telegram id ${raw}.`);
          const admins = await tx
            .select({ userId: s.platformAdmins.userId })
            .from(s.platformAdmins);
          if (!admins.some((row) => row.userId === found.id)) {
            throw new Refusal(`${found.displayName} is not a platform administrator.`);
          }
          if (admins.length === 1) {
            throw new Refusal('Refusing to remove the last platform administrator.');
          }
          await tx.delete(s.platformAdmins).where(eq(s.platformAdmins.userId, found.id));
          return found;
        }),
      );
      console.log(kleur.yellow('Revoked platform admin:'), user.displayName);
    });
}
