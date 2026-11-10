/**
 * Review TEST2-01 (2026-11-09): row-level security for every table, found
 * from the database catalog instead of a hand-kept list.
 *
 * rls-isolation.test.ts proves A/B isolation row by row, but only for the
 * tables someone remembered to add: 25 of the 49 tables in
 * 900_rls_policies.sql were missing, all twelve attendance tables (face
 * enrolments, samples, punch frames) among them, and FORCE was checked on
 * three. Here every table in the tenant schemas must be one of:
 *   - a tenant table (an `org_id` column): RLS on, FORCE on, and a policy
 *     that admits `org_id = app_current_org()` or the system context and
 *     nothing else;
 *   - a child table isolated through its parent row (listed below): RLS
 *     on, FORCE on, a policy on the tenant or the system context;
 *   - a table with no tenant data, deliberately without RLS (listed below,
 *     with the reason; see the note at the end of 900_rls_policies.sql).
 * A new table that is none of these fails here instead of shipping open.
 *
 * Reads pg_class, pg_attribute and pg_policies only (not
 * information_schema, which hides tables the role has no grant on), so it
 * holds for any connecting role.
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';

const SCHEMAS = ['auth', 'domain', 'inventory', 'ops', 'read_model', 'sync'];

/** No `org_id`; isolated through the parent row named here. */
const CHILD_TABLES: Record<string, string> = {
  'auth.organizations': 'is the tenant itself (org_self: id = app_current_org())',
  'auth.member_permission_overrides': 'auth.members',
  'auth.member_role_bindings': 'auth.roles',
  'auth.member_store_assignments': 'auth.members',
  'auth.role_permissions': 'auth.roles',
  'domain.snapshots': 'domain.events of the same stream',
  'inventory.dish_ingredients': 'inventory.dishes',
  'inventory.sku_supplier_links': 'inventory.skus',
  'inventory.store_supplier_prefs': 'inventory.stores',
  'read_model.order_items_v': 'read_model.order_sessions_v',
  'read_model.run_item_stores_v': 'read_model.market_runs_v',
  'read_model.run_items_v': 'read_model.market_runs_v',
};

/** Deliberately without RLS: no tenant data, or scoped by user in the API. */
const WITHOUT_RLS: Record<string, string> = {
  'auth.billing_plans': 'the plan catalog, the same for every workspace',
  'auth.permissions': 'the permission key catalog',
  'auth.platform_admins': 'operators of the platform, above any workspace',
  'auth.users': 'one Telegram user across workspaces; the API checks user_id',
  'auth.refresh_tokens': 'per user; the API checks user_id',
  'domain.projector_cursors': 'one row per projector, no tenant',
  'ops.client_logs': 'per user and session; the API checks user_id',
  'ops.log_review_cursor': 'per reviewer; the API checks user_id',
  'ops.web_push_subscriptions': 'per user; the API checks user_id',
  'sync.idempotency_keys': 'request plumbing, worker and API only',
  'sync.outbox': 'request plumbing, worker and API only',
};

type Row = {
  t: string;
  has_org_id: boolean;
  rls: boolean;
  forced: boolean;
  policies: Array<{ name: string; using: string | null; check: string | null }> | null;
};

async function catalog(): Promise<Row[]> {
  const db = getDb(undefined, { system: 'maintenance' });
  const r = await db.execute(sql`
    SELECT n.nspname || '.' || c.relname AS t,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'org_id'
               AND a.attnum > 0 AND NOT a.attisdropped
           ) AS has_org_id,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS forced,
           (SELECT json_agg(json_build_object('name', p.policyname, 'using', p.qual, 'check', p.with_check))
              FROM pg_policies p
             WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname IN (${sql.join(
      SCHEMAS.map((s) => sql`${s}`),
      sql`, `,
    )})
    ORDER BY 1
  `);
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[];
}

/** A policy expression without spaces and parentheses, as pg_policies prints it. */
const squash = (s: string) => s.replace(/[\s()]/g, '');

describe.skipIf(!SHOULD_RUN)('row-level security from the catalog (TEST2-01)', () => {
  afterAll(async () => {
    await closeDb();
  });

  test('every table is a tenant table, a listed child table or listed as without RLS', async () => {
    const unlisted = (await catalog())
      .filter((r) => !r.has_org_id && !(r.t in CHILD_TABLES) && !(r.t in WITHOUT_RLS))
      .map((r) => r.t);
    expect(unlisted).toEqual([]);
  });

  test('every listed table exists', async () => {
    const tables = new Set((await catalog()).map((r) => r.t));
    const missing = [...Object.keys(CHILD_TABLES), ...Object.keys(WITHOUT_RLS)].filter(
      (t) => !tables.has(t),
    );
    expect(missing).toEqual([]);
  });

  test('tenant and child tables have RLS, FORCE and a policy', async () => {
    const wrong = (await catalog())
      .filter((r) => !(r.t in WITHOUT_RLS))
      .filter((r) => !r.rls || !r.forced || !r.policies?.length)
      .map((r) => `${r.t}: rls=${r.rls} force=${r.forced} policies=${r.policies?.length ?? 0}`);
    expect(wrong).toEqual([]);
  });

  test('tenant policies admit only the tenant or the system context', async () => {
    const wrong: string[] = [];
    for (const r of await catalog()) {
      if (r.t in WITHOUT_RLS) continue;
      for (const p of r.policies ?? []) {
        for (const expr of [p.using, p.check]) {
          if (expr === null) continue;
          const e = squash(expr);
          // The fail-open form that 950_rls_fail_closed.sql rewrites.
          if (e.includes('app_current_orgISNULL')) wrong.push(`${r.t} ${p.name}: fail-open`);
          if (!e.includes('app_is_system')) wrong.push(`${r.t} ${p.name}: no system context`);
          if (!e.includes('app_current_org')) wrong.push(`${r.t} ${p.name}: no tenant`);
          if (r.has_org_id && !e.includes('org_id=app_current_org')) {
            wrong.push(`${r.t} ${p.name}: not org_id = app_current_org()`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
