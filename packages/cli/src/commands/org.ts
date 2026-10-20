import type { Command } from 'commander';
import kleur from 'kleur';
import { closeDb, getDb, provisionOrganization, withSystemContext } from '@compass/db';

export function registerOrgCommands(parent: Command): void {
  parent
    .command('list')
    .description('List organizations')
    .action(async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const rows = await db.query.organizations.findMany({
        orderBy: (o, { asc }) => asc(o.createdAt),
      });
      console.table(rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, plan: r.plan })));
      await closeDb();
    });

  parent
    .command('create <slug>')
    .description('Create a new organization')
    .option('--name <name>', 'Display name', '')
    .option('--locale <locale>', 'Default locale', 'en')
    .option('--timezone <tz>', 'Default timezone', 'Asia/Tashkent')
    .option('--owner <tgUserId>', 'Telegram user id to make the first admin')
    .action(
      async (
        slug: string,
        opts: { name?: string; locale: string; timezone: string; owner?: string },
      ) => {
        const db = getDb(undefined, { system: 'maintenance' });
        let ownerUserId: string | null = null;
        if (opts.owner) {
          const owner = await db.query.users.findFirst({
            where: (u, { eq }) => eq(u.tgUserId, BigInt(opts.owner!)),
          });
          if (!owner) {
            console.error(`No user with Telegram id ${opts.owner}. Invite them first.`);
            await closeDb();
            process.exit(1);
          }
          ownerUserId = owner.id;
        }
        const created = await withSystemContext(db, 'maintenance', (tx) =>
          provisionOrganization(tx, {
            slug,
            name: opts.name || slug,
            locale: opts.locale,
            timezone: opts.timezone,
            ownerUserId,
          }),
        );
        console.log(kleur.green('Created'), created);
        await closeDb();
      },
    );
}
