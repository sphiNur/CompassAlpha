/**
 * Review ADM2-04 (2026-11-11): what each maintenance purge removes is one
 * list, which the preview counts and the purge deletes. Pure; the PG test
 * in apps/api/src/__tests__/purge-guards.test.ts checks that every
 * preview's numbers are the rows its purge deletes.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema as s } from '@compass/db';
import {
  datePurge,
  notificationsOfStreams,
  outboxOfOrg,
  outboxOfStreams,
  purgeKey,
  runMovements,
  runPurge,
  sessionPurge,
  workspacePurge,
  type PurgeStep,
} from '../purgePlans';

const ORG = '00000000-0000-4000-8000-000000000003';
const RUN = '00000000-0000-4000-8000-0000000000aa';
const SESSION = '00000000-0000-4000-8000-0000000000bb';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);
const keys = (steps: PurgeStep[]) => steps.map((step) => purgeKey(step.table));

const PLANS: Record<string, PurgeStep[]> = {
  workspace: workspacePurge(ORG),
  date: datePurge(ORG, [SESSION], [RUN]),
  order: sessionPurge(ORG, SESSION),
  run: runPurge(ORG, RUN, [SESSION]),
};

describe('purge plans (ADM2-04)', () => {
  test("a table's key is the name the previews have always used", () => {
    expect(purgeKey(s.inventoryMovements)).toBe('inventory.movements');
    expect(purgeKey(s.orderItemsV)).toBe('read_model.order_items_v');
    expect(purgeKey(s.events)).toBe('domain.events');
  });

  test('the workspace purge reaches every table the old lists did, and no other', () => {
    expect(keys(PLANS.workspace!).sort()).toEqual(
      [
        'domain.events',
        'domain.snapshots',
        'inventory.movements',
        'inventory.price_history',
        'ops.client_logs',
        'ops.notifications',
        'read_model.market_runs_v',
        'read_model.order_items_v',
        'read_model.order_sessions_v',
        'read_model.run_expenses_v',
        'read_model.run_item_stores_v',
        'read_model.run_items_v',
        'sync.outbox',
      ].sort(),
    );
  });

  test('a date and a run reach the same tables; one order only its own', () => {
    const runTables = keys(PLANS.run!).sort();
    expect(keys(PLANS.date!).sort()).toEqual(runTables);
    expect(keys(PLANS.order!).sort()).toEqual(
      [
        'domain.events',
        'domain.snapshots',
        'ops.notifications',
        'read_model.order_items_v',
        'read_model.order_sessions_v',
        'sync.outbox',
      ].sort(),
    );
  });

  for (const [name, steps] of Object.entries(PLANS)) {
    test(`${name}: each table once, and no daily close`, () => {
      const names = keys(steps);
      expect(new Set(names).size).toBe(names.length);
      // Revisions refuse DELETE (0037): a scope with a close is refused
      // before the purge counts anything.
      expect(names.filter((n) => n.includes('settlement'))).toEqual([]);
    });

    test(`${name}: what points at a row goes before it`, () => {
      const names = keys(steps);
      const before = (a: string, b: string) => {
        if (names.includes(a) && names.includes(b)) {
          expect(names.indexOf(a)).toBeLessThan(names.indexOf(b));
        }
      };
      // Sub-selects and foreign keys into the runs and the orders.
      for (const child of [
        'inventory.movements',
        'read_model.run_item_stores_v',
        'read_model.run_items_v',
      ]) {
        before(child, 'read_model.market_runs_v');
      }
      before('read_model.order_items_v', 'read_model.order_sessions_v');
      // The outbox's event_id and the snapshots' sub-select read the events.
      before('sync.outbox', 'domain.events');
      before('domain.snapshots', 'domain.events');
    });

    test(`${name}: only run expenses are left to the foreign key`, () => {
      const cascaded = steps.filter((step) => step.cascade).map((step) => purgeKey(step.table));
      expect(cascaded).toEqual(
        keys(steps).includes('read_model.run_expenses_v') ? ['read_model.run_expenses_v'] : [],
      );
    });
  }

  test('every step of a scoped purge is bound to the organisation or to the given ids', () => {
    for (const steps of [PLANS.date!, PLANS.order!, PLANS.run!]) {
      for (const step of steps) {
        const q = render(step.where);
        expect(q.params.some((p) => p === ORG || p === RUN || p === SESSION)).toBe(true);
      }
    }
  });
});

describe('purge predicates (CA-28)', () => {
  test('org outbox match includes notification rows keyed by payload orgId', () => {
    const q = render(outboxOfOrg(ORG));
    expect(q.sql).toContain("aggregate = 'notification'");
    expect(q.sql).toContain("payload->>'orgId'");
    expect(q.params).toEqual([ORG, ORG]);
  });

  test('stream outbox match covers payload.extra sessionId / runId', () => {
    const q = render(outboxOfStreams(ORG, [RUN, SESSION]));
    expect(q.sql).toContain("payload->'extra'->>'sessionId'");
    expect(q.sql).toContain("payload->'extra'->>'runId'");
    expect(q.params).toContain(RUN);
    expect(q.params).toContain(SESSION);
  });

  test('notifications are matched by the sessionId or runId at the top of the payload', () => {
    const q = render(notificationsOfStreams(ORG, [RUN]));
    expect(q.sql).toContain("payload->>'sessionId'");
    expect(q.sql).toContain("payload->>'runId'");
    expect(q.params).toEqual([ORG, RUN, RUN]);
  });

  test('run movements predicate is org + run scoped', () => {
    const q = render(runMovements(ORG, [RUN]));
    expect(q.sql).toContain("source_type IN ('run', 'run_amend')");
    expect(q.params).toEqual([ORG, RUN]);
  });

  test('empty id lists match nothing', () => {
    expect(render(outboxOfStreams(ORG, [])).sql).toBe('false');
    expect(render(notificationsOfStreams(ORG, [])).sql).toBe('false');
    expect(render(runMovements(ORG, [])).sql).toBe('false');
  });
});
