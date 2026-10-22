/**
 * 2026-10-23: moving a run onto a day that already has a run.
 *
 * Runs are numbered per day (read_model.market_runs_v is unique on
 * org + run_date + run_index). Changing the 23rd's run #0 to the 22nd,
 * where Lagman's run #0 already was, violated that index and came back
 * as "edited by someone else — retry". The moved run now becomes the
 * day's next run.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  getDb,
  provisionOrganization,
  schema as s,
  withOrgContext,
  withSystemContext,
} from '@compass/db';
import type { RunEvent } from '@compass/domain/run';
import { logger } from '../infra/log';
import { appendEvents } from '../services/eventStore';
import { projectRun } from '../services/runProjection';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

function caller(session: SessionContext) {
  const db = getDb();
  const ctx: RequestContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn) {
      return withOrgContext(db, session.orgId, fn);
    },
  };
  return appRouter.createCaller(ctx);
}

describe.skipIf(!SHOULD_RUN)('run.changeDate onto a day that has a run (PG-gated)', () => {
  let userId = '';
  let orgId = '';
  let memberId = '';
  let session: SessionContext;

  async function plannedRun(runDate: string, runIndex: number): Promise<string> {
    const runId = randomUUID();
    const event: RunEvent = {
      streamId: runId,
      seq: 1,
      occurredAt: new Date(),
      actorUserId: userId,
      actorMemberId: memberId,
      type: 'RunPlanned',
      payload: {
        orgId,
        runDate,
        runIndex,
        sessionIds: [],
        plannedItems: [],
        purchaserMemberId: memberId,
      },
    };
    await withOrgContext(getDb(), orgId, async (tx) => {
      await appendEvents(tx, { streamType: 'run', streamId: runId, orgId, events: [event] });
      await projectRun(tx, orgId, [event]);
      // Only one planned/purchasing run may exist per org (0047), and the
      // runs being re-dated are finished ones; mark the row finished so the
      // next one can be planned. The domain allows a date change in any
      // phase but cancelled.
      await tx
        .update(s.marketRunsV)
        .set({ status: 'finished' })
        .where(eq(s.marketRunsV.id, runId));
    });
    return runId;
  }

  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const [user] = await db
      .insert(s.users)
      .values({
        tgUserId: BigInt(9_100_000_000 + Math.floor(Math.random() * 800_000_000)),
        displayName: 'Date Fixer',
        displayNameLocked: true,
      })
      .returning();
    userId = user!.id;
    const org = await withSystemContext(db, 'maintenance', (tx) =>
      provisionOrganization(tx, {
        name: 'Redate',
        slug: `redate-${Math.random().toString(36).slice(2, 8)}`,
        ownerUserId: userId,
      }),
    );
    orgId = org.orgId;
    memberId = org.ownerMemberId!;
    // run.amend is super-admin only.
    await withOrgContext(db, orgId, async (tx) => {
      const superAdmin = await tx.query.roles.findFirst({
        where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.orgId, orgId), eq2(r.slug, 'super_admin')),
      });
      await tx
        .insert(s.memberRoleBindings)
        .values({ memberId, roleId: superAdmin!.id, scopeType: 'global' });
    });
    session = {
      userId,
      memberId,
      orgId,
      orgTimezone: 'UTC',
      permissions: new Set(['run.amend', 'org.admin']),
      roleSlugs: new Set(['super_admin']),
    };
  });

  afterAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    if (orgId) await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    if (userId) await db.delete(s.users).where(eq(s.users.id, userId));
  });

  test('the moved run becomes the next run of that day', async () => {
    const lagman = await plannedRun('2026-10-22', 0);
    const threeStores = await plannedRun('2026-10-23', 0);

    await caller(session).run.changeDate({ runId: threeStores, runDate: '2026-10-22' });

    const db = getDb(undefined, { system: 'maintenance' });
    const rows = await db
      .select({ id: s.marketRunsV.id, runIndex: s.marketRunsV.runIndex })
      .from(s.marketRunsV)
      .where(and(eq(s.marketRunsV.orgId, orgId), eq(s.marketRunsV.runDate, '2026-10-22')));
    const index = new Map(rows.map((r) => [r.id, r.runIndex]));
    expect(index.get(lagman)).toBe(0);
    expect(index.get(threeStores)).toBe(1);

    // The number is in the event, so a replay lands on the same row.
    const [ev] = await db
      .select({ payload: s.events.payload })
      .from(s.events)
      .where(and(eq(s.events.streamId, threeStores), eq(s.events.type, 'RunDateChanged')));
    expect((ev!.payload as { runIndex?: number }).runIndex).toBe(1);
  });

  test('moving onto an empty day makes it that day’s first run', async () => {
    const run = await plannedRun('2026-10-24', 0);
    await caller(session).run.changeDate({ runId: run, runDate: '2026-11-01' });
    const db = getDb(undefined, { system: 'maintenance' });
    const [row] = await db
      .select({ runIndex: s.marketRunsV.runIndex, runDate: s.marketRunsV.runDate })
      .from(s.marketRunsV)
      .where(eq(s.marketRunsV.id, run));
    expect(row).toEqual({ runIndex: 0, runDate: '2026-11-01' });
  });
});
