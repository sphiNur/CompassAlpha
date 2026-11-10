import type { Command } from 'commander';
import kleur from 'kleur';
import { eq } from 'drizzle-orm';
import { ADMIN_RANK } from '@compass/contracts/schemas/roles';
import { closeDb, getDb, schema as s } from '@compass/db';
import { loadRepoEnv } from '@compass/db/env';

loadRepoEnv(import.meta.url);

/** A refusal: said in red, nothing written. */
class Refusal extends Error {}

export function registerUserCommands(parent: Command): void {
  parent
    .command('grant <tgUserId>')
    .description('Grant a role to a user (looked up by Telegram user id)')
    .requiredOption('--role <slug>', 'Role slug')
    .requiredOption('--org <slug>', 'Org slug')
    .option('--scope <type>', 'Scope type (global|store)', 'global')
    .option('--scope-id <uuid>', 'Scope id when scope=store')
    .option('--new-user', 'The person has no account yet (never given access): create it')
    .action(
      async (
        tgUserIdRaw: string,
        opts: {
          role: string;
          org: string;
          scope: string;
          scopeId?: string;
          newUser?: boolean;
        },
      ) => {
        const db = getDb(undefined, { system: 'maintenance' });
        try {
          const done = await grant(db, tgUserIdRaw, opts);
          console.log(kleur.green(done.granted ? 'Granted' : 'Already held'), done.what);
        } catch (err) {
          if (!(err instanceof Refusal)) throw err;
          console.error(kleur.red(err.message));
          process.exitCode = 1;
        } finally {
          await closeDb();
        }
      },
    );

  parent
    .command('list')
    .description('List users in an organization')
    .requiredOption('--org <slug>', 'Org slug')
    .action(async (opts: { org: string }) => {
      const db = getDb(undefined, { system: 'maintenance' });
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

/**
 * OPS-24 (2026-11-09): the same rules as admin.grantRole, in one
 * transaction. It used to delete every binding of the role at that scope
 * type first (another store's too) and insert outside a transaction, so a
 * missing --scope-id left the person with nothing. An unknown Telegram id
 * became a new user holding the role: a mistyped id could make a stranger
 * super admin.
 */
async function grant(
  db: ReturnType<typeof getDb>,
  tgUserIdRaw: string,
  opts: {
    role: string;
    org: string;
    scope: string;
    scopeId?: string;
    newUser?: boolean;
  },
): Promise<{ granted: boolean; what: Record<string, string> }> {
  if (!/^[1-9]\d{0,18}$/.test(tgUserIdRaw)) {
    throw new Refusal(`Not a Telegram user id: ${tgUserIdRaw}`);
  }
  const tgUserId = BigInt(tgUserIdRaw);
  if (opts.scope !== 'global' && opts.scope !== 'store') {
    throw new Refusal(`--scope is global or store, not ${opts.scope}`);
  }
  const scopeType = opts.scope;
  if (scopeType === 'store' && !opts.scopeId) {
    throw new Refusal('--scope store needs --scope-id <store id>');
  }
  if (opts.scopeId && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(opts.scopeId)) {
    throw new Refusal(`Not a store id: ${opts.scopeId}`);
  }
  if (scopeType === 'global' && opts.scopeId) {
    throw new Refusal('--scope-id goes with --scope store');
  }
  const scopeId = scopeType === 'store' ? opts.scopeId! : null;

  return db.transaction(async (tx) => {
    const org = await tx.query.organizations.findFirst({
      where: (o, { eq: eq2 }) => eq2(o.slug, opts.org),
    });
    if (!org) throw new Refusal(`No org with slug=${opts.org}`);
    const role = await tx.query.roles.findFirst({
      where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.orgId, org.id), eq2(r.slug, opts.role)),
    });
    if (!role) {
      throw new Refusal(`No role with slug=${opts.role} in org ${opts.org}. Run db:seed first.`);
    }
    // The tiers admin.grantRole keeps. From admin up, or carrying org.admin,
    // a role is the organisation's: bound to one store it would still hand
    // out org.admin. Below admin it is held at given stores (2026-05-05): a
    // global one shows every store's orders to that person.
    const orgAdmin = await tx.query.rolePermissions.findFirst({
      where: (rp, { eq: eq2, and: and2 }) =>
        and2(eq2(rp.roleId, role.id), eq2(rp.permissionKey, 'org.admin')),
    });
    if ((role.rank >= ADMIN_RANK || orgAdmin) && scopeType !== 'global') {
      throw new Refusal(`${role.slug} is held across the organisation: leave out --scope store.`);
    }
    if (role.rank < ADMIN_RANK && scopeType !== 'store') {
      throw new Refusal(
        `${role.slug} is held at a store: add --scope store --scope-id <store id>.`,
      );
    }
    if (scopeId) {
      const store = await tx.query.stores.findFirst({
        where: (st, { eq: eq2, and: and2 }) => and2(eq2(st.id, scopeId), eq2(st.orgId, org.id)),
      });
      if (!store) throw new Refusal(`No store ${scopeId} in org ${opts.org}`);
    }

    let user = await tx.query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
    });
    if (!user) {
      // Opening the app does not create an account (auth.telegramLogin turns
      // an unknown id away), so someone never given access has none. Asking
      // for it keeps a mistyped id from becoming a stranger's account.
      if (!opts.newUser) {
        throw new Refusal(
          `No account has Telegram id ${tgUserIdRaw}. If it is the id the person sent you, ` +
            'they were never given access: re-run with --new-user.',
        );
      }
      // Filled in by auth.telegramLogin on their first sign-in.
      [user] = await tx
        .insert(s.users)
        .values({ tgUserId, displayName: `tg:${tgUserIdRaw}` })
        .returning();
      if (!user) throw new Error('failed to create the user');
      console.log(kleur.yellow(`Created an account for Telegram id ${tgUserIdRaw}.`));
    }

    await tx.insert(s.members).values({ orgId: org.id, userId: user.id }).onConflictDoNothing();
    const member = await tx.query.members.findFirst({
      where: (m, { eq: eq2, and: and2 }) => and2(eq2(m.orgId, org.id), eq2(m.userId, user.id)),
    });
    if (!member) throw new Error('failed to create member');

    // One binding per member, role and scope (mrb_binding_unique); the
    // person's other bindings stay as they are.
    const [created] = await tx
      .insert(s.memberRoleBindings)
      .values({ memberId: member.id, roleId: role.id, scopeType, scopeId })
      .onConflictDoNothing()
      .returning({ id: s.memberRoleBindings.id });
    if (created) {
      // In the admin audit like a grant from the app; no member acted.
      await tx.insert(s.policyDecisions).values({
        orgId: org.id,
        actorId: null,
        action: 'admin.role.grant',
        resourceType: 'member',
        resourceId: member.id,
        decision: 'allow',
        reason: 'cli',
        inputs: {
          memberId: member.id,
          roleId: role.id,
          scopeType,
          scopeId,
          bindingId: created.id,
          roleRank: role.rank,
        },
        scopeStoreId: scopeId,
      });
    }
    return {
      granted: !!created,
      what: {
        user: user.displayName,
        role: role.slug,
        org: org.slug,
        ...(scopeId ? { store: scopeId } : {}),
      },
    };
  });
}
