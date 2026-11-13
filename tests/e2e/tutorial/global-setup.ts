/**
 * The tutorial starts like the e2e run (an empty database, migrated) and
 * then, instead of the development seed, makes the demo workspace's
 * organisation and its owner with the operator's CLI. The rest of the
 * workspace is seeded through the api once it runs (seed.ts).
 */
import postgres from 'postgres';
import { DATABASE_URL } from '../env';
import { createAppRole, pnpmAtRoot, resetDatabase } from '../global-setup';
import { drawCameraFeed } from './camera';
import { ORG_NAME, TG_IDS } from './demo';
import { tutorialLang } from './lang';

export const ORG_SLUG = 'demo';

export default async function globalSetup(): Promise<void> {
  const lang = tutorialLang();
  await resetDatabase();
  pnpmAtRoot(['compass', 'org', 'create', ORG_SLUG, '--name', ORG_NAME[lang], '--locale', lang]);
  // A new organisation starts on the one-store trial; the demo has three.
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.system_context', 'maintenance', true)`;
      const [org] = await tx`select id from auth.organizations where slug = ${ORG_SLUG}`;
      await tx`update auth.organization_subscriptions
        set plan_code = 'pro', status = 'active' where org_id = ${org!.id}`;
      await tx`update auth.organizations set plan = 'pro' where id = ${org!.id}`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  pnpmAtRoot([
    'compass',
    'user',
    'grant',
    TG_IDS.owner,
    '--role',
    'super_admin',
    '--org',
    ORG_SLUG,
    '--new-user',
  ]);
  await createAppRole();
  await drawCameraFeed();
}
