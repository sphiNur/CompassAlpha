/**
 * 2026-10-23: moving a run onto a day that already has a run.
 *
 * Runs are numbered per day (read_model.market_runs_v is unique on
 * org + run_date + run_index). Changing the 23rd's run #0 to the 22nd,
 * where Store B's run #0 already was, violated that index and came back
 * as "edited by someone else — retry". The moved run now becomes the
 * day's next run.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import type { SessionContext } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import { seedOwnedOrg, type SeededMember } from './helpers/fixtures';
import { planRun, runStream } from './helpers/streams';

describe.skipIf(!SHOULD_RUN)('run.changeDate onto a day that has a run (PG-gated)', () => {
  let orgId = '';
  let owner: SeededMember | null = null;
  let session: SessionContext;

  async function plannedRun(runDate: string, runIndex: number): Promise<string> {
    const run = runStream(orgId);
    await planRun(run, orgId, { by: owner!, sessionIds: [], plannedItems: [], runDate, runIndex });
    // Only one planned/purchasing run may exist per org (0047), and the
    // runs being re-dated are finished ones; mark the row finished so the
    // next one can be planned. The domain allows a date change in any
    // phase but cancelled.
    await getDb(undefined, { system: 'maintenance' })
      .update(s.marketRunsV)
      .set({ status: 'finished' })
      .where(eq(s.marketRunsV.id, run.id));
    return run.id;
  }

  beforeAll(async () => {
    // run.amend is for Super Admin, which the owner holds.
    const org = await seedOwnedOrg(getDb(undefined, { system: 'maintenance' }), 'Redate');
    orgId = org.orgId;
    owner = org.owner;
    session = org.session;
  });

  afterAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    if (orgId) await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    if (owner) await db.delete(s.users).where(eq(s.users.id, owner.userId));
  });

  test('the moved run becomes the next run of that day', async () => {
    const southRun = await plannedRun('2026-10-22', 0);
    const threeStores = await plannedRun('2026-10-23', 0);

    await callerFor(session).run.changeDate({ runId: threeStores, runDate: '2026-10-22' });

    const db = getDb(undefined, { system: 'maintenance' });
    const rows = await db
      .select({ id: s.marketRunsV.id, runIndex: s.marketRunsV.runIndex })
      .from(s.marketRunsV)
      .where(and(eq(s.marketRunsV.orgId, orgId), eq(s.marketRunsV.runDate, '2026-10-22')));
    const index = new Map(rows.map((r) => [r.id, r.runIndex]));
    expect(index.get(southRun)).toBe(0);
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
    await callerFor(session).run.changeDate({ runId: run, runDate: '2026-10-26' });
    const db = getDb(undefined, { system: 'maintenance' });
    const [row] = await db
      .select({ runIndex: s.marketRunsV.runIndex, runDate: s.marketRunsV.runDate })
      .from(s.marketRunsV)
      .where(eq(s.marketRunsV.id, run));
    expect(row).toEqual({ runIndex: 0, runDate: '2026-10-26' });
  });

  test('HIS-7: a run cannot be moved to a day that has not come yet', async () => {
    const run = await plannedRun('2026-10-25', 0);
    const move = () => callerFor(session).run.changeDate({ runId: run, runDate: '2099-01-01' });
    expect(await errorOf(move)).toMatchObject({ message: 'run.errors.runDateInFuture' });
  });
});
