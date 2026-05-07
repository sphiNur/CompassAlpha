import type { Command } from 'commander';
import kleur from 'kleur';
import { and, eq } from 'drizzle-orm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { closeDb, getDb, schema as s } from '@compass/db';

(function loadRootEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

export function registerUserCommands(parent: Command): void {
  parent
    .command('grant <tgUserId>')
    .description('Grant a role to a user (looked up by Telegram user id)')
    .requiredOption('--role <slug>', 'Role slug')
    .requiredOption('--org <slug>', 'Org slug')
    .option('--scope <type>', 'Scope type (global|store)', 'global')
    .option('--scope-id <uuid>', 'Scope id when scope=store')
    .action(
      async (
        tgUserIdRaw: string,
        opts: { role: string; org: string; scope: 'global' | 'store'; scopeId?: string },
      ) => {
        const db = getDb();
        const tgUserId = BigInt(tgUserIdRaw);
        let user = await db.query.users.findFirst({
          where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
        });
        if (!user) {
          // Auto-provision a placeholder user — the row will be enriched by
          // auth.telegramLogin on first sign-in (display name, avatar, locale).
          const [created] = await db
            .insert(s.users)
            .values({
              tgUserId,
              displayName: `tg:${tgUserIdRaw}`,
            })
            .returning();
          user = created;
          if (!user) throw new Error('failed to create placeholder user');
          console.log(kleur.yellow('Auto-provisioned user; will be enriched on first Telegram sign-in.'));
        }
        const org = await db.query.organizations.findFirst({
          where: (o, { eq: eq2 }) => eq2(o.slug, opts.org),
        });
        if (!org) {
          console.error(kleur.red(`No org with slug=${opts.org}`));
          await closeDb();
          process.exit(1);
        }

        // Ensure member.
        let member = await db.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.orgId, org.id), eq2(m.userId, user.id)),
        });
        if (!member) {
          [member] = await db.insert(s.members).values({ orgId: org.id, userId: user.id }).returning();
        }
        if (!member) throw new Error('failed to create member');

        // Find or create the role.
        const role = await db.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.orgId, org.id), eq2(r.slug, opts.role)),
        });
        if (!role) {
          console.error(kleur.red(`No role with slug=${opts.role} in org ${opts.org}. Run db:seed first.`));
          await closeDb();
          process.exit(1);
        }

        // Drop existing global bindings for this role+member, then insert new.
        await db
          .delete(s.memberRoleBindings)
          .where(
            and(
              eq(s.memberRoleBindings.memberId, member.id),
              eq(s.memberRoleBindings.roleId, role.id),
              eq(s.memberRoleBindings.scopeType, opts.scope),
            ),
          );
        await db.insert(s.memberRoleBindings).values({
          memberId: member.id,
          roleId: role.id,
          scopeType: opts.scope,
          scopeId: opts.scopeId ?? null,
        });
        console.log(kleur.green('Granted'), { user: user.displayName, role: role.slug, org: org.slug });
        await closeDb();
      },
    );

  parent
    .command('list')
    .description('List users in an organization')
    .requiredOption('--org <slug>', 'Org slug')
    .action(async (opts: { org: string }) => {
      const db = getDb();
      const org = await db.query.organizations.findFirst({
        where: (o, { eq: eq2 }) => eq2(o.slug, opts.org),
      });
      if (!org) {
        console.error(kleur.red(`No org with slug=${opts.org}`));
        await closeDb();
        process.exit(1);
      }
      const rows = await db
        .select({
          memberId: s.members.id,
          userId: s.users.id,
          tgUserId: s.users.tgUserId,
          displayName: s.users.displayName,
          memberStatus: s.members.status,
        })
        .from(s.members)
        .innerJoin(s.users, eq(s.users.id, s.members.userId))
        .where(eq(s.members.orgId, org.id));
      console.table(rows);
      await closeDb();
    });
}
