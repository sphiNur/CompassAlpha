import type { Command } from 'commander';
import kleur from 'kleur';
import { closeDb, getDb, schema as s } from '@compass/db';

export function registerOrgCommands(parent: Command): void {
  parent
    .command('list')
    .description('List organizations')
    .action(async () => {
      const db = getDb();
      const rows = await db.query.organizations.findMany({ orderBy: (o, { asc }) => asc(o.createdAt) });
      console.table(rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, plan: r.plan })));
      await closeDb();
    });

  parent
    .command('create <slug>')
    .description('Create a new organization')
    .option('--name <name>', 'Display name', '')
    .option('--locale <locale>', 'Default locale', 'en')
    .option('--timezone <tz>', 'Default timezone', 'UTC')
    .action(async (slug: string, opts: { name?: string; locale: string; timezone: string }) => {
      const db = getDb();
      const [org] = await db
        .insert(s.organizations)
        .values({
          slug,
          name: opts.name || slug,
          localeDefault: opts.locale,
          timezone: opts.timezone,
        })
        .returning();
      console.log(kleur.green('Created'), org);
      await closeDb();
    });
}
