import type { Command } from 'commander';
import kleur from 'kleur';
import { provisionOrganization, withSystemContext } from '@compass/db';
import { withMaintenanceDb } from '../db';
import { parseTgUserId, Refusal } from '../refusal';

export function registerOrgCommands(parent: Command): void {
  parent
    .command('list')
    .description('List organizations')
    .action(() =>
      withMaintenanceDb(async (db) => {
        const rows = await db.query.organizations.findMany({
          orderBy: (o, { asc }) => asc(o.createdAt),
        });
        console.table(rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, plan: r.plan })));
      }),
    );

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
        const ownerTgUserId = opts.owner === undefined ? null : parseTgUserId(opts.owner);
        const created = await withMaintenanceDb(async (db) => {
          let ownerUserId: string | null = null;
          if (ownerTgUserId !== null) {
            const owner = await db.query.users.findFirst({
              where: (u, { eq }) => eq(u.tgUserId, ownerTgUserId),
            });
            if (!owner) {
              throw new Refusal(`No user with Telegram id ${opts.owner}. Invite them first.`);
            }
            ownerUserId = owner.id;
          }
          return withSystemContext(db, 'maintenance', (tx) =>
            provisionOrganization(tx, {
              slug,
              name: opts.name || slug,
              locale: opts.locale,
              timezone: opts.timezone,
              ownerUserId,
            }),
          );
        });
        console.log(kleur.green('Created'), created);
      },
    );
}
