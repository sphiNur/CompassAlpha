/**
 * Removing what a PG test made (review TEST1-07, 2026-11-10). A run of the
 * PG tests used to leave dozens of organisations and hundreds of users in
 * the test database, piling up from run to run.
 *
 * Deleting an organisation removes everything in it: members, stores,
 * catalog, runs and its events (the event store lets the foreign-key
 * cascade through). Users belong to no organisation and are removed after
 * the organisations, once nothing in one points at them any more (who
 * granted a role, assigned a store, delivered a line).
 *
 * An organisation that holds daily-close revisions stays, with its
 * members' users: the revisions are kept for good, and their table
 * refuses every delete, a cascade's too (migration 0037). The admin purges
 * and purge-fake-data refuse such an organisation the same way. The
 * settlement, purge-guard and RLS tests leave four of them a run.
 *
 * A test file calls `cleanUpAfterAll()` once and passes each organisation
 * and user it inserts itself to `noteOrg` / `noteUser`. The fixtures in
 * this folder note what they make, and `freshTgId` notes each Telegram id
 * it hands out, so a user the API makes at sign-in or on accepting an
 * invite goes too. bun runs a process's test files one after another, so
 * what is noted was made by the file that is running, or by an earlier
 * one that cleans up after itself.
 */
import { afterAll } from 'bun:test';
import { and, eq, exists, inArray, not } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { SHOULD_RUN } from './pg';

const noted = {
  orgs: new Set<string>(),
  users: new Set<string>(),
  tgIds: new Set<bigint>(),
};

/** An organisation to remove when the file is done; returns its id. */
export function noteOrg(id: string): string {
  noted.orgs.add(id);
  return id;
}

/** A user to remove when the file is done; returns its id. */
export function noteUser(id: string): string {
  noted.users.add(id);
  return id;
}

/**
 * A Telegram id handed to a test; the user it became, if any, is removed
 * when the file is done. Returns the id.
 */
export function noteTgId(id: bigint): bigint {
  noted.tgIds.add(id);
  return id;
}

/**
 * Deletes the organisations, then the users. Every row is tried even when
 * another fails, and the failures are thrown together at the end.
 */
async function removeTestData(rows: {
  orgIds: string[];
  userIds: string[];
  tgIds: bigint[];
}): Promise<void> {
  const db = getDb(undefined, { system: 'maintenance' });
  const revisions = s.storeDailySettlementRevisions;
  const kept =
    rows.orgIds.length === 0
      ? []
      : (
          await db
            .selectDistinct({ orgId: revisions.orgId })
            .from(revisions)
            .where(inArray(revisions.orgId, rows.orgIds))
        ).map((row) => row.orgId);
  const signedIn =
    rows.tgIds.length === 0
      ? []
      : (
          await db
            .select({ id: s.users.id })
            .from(s.users)
            .where(inArray(s.users.tgUserId, rows.tgIds))
        ).map((row) => row.id);
  const inKeptOrg =
    kept.length === 0
      ? undefined
      : exists(
          db
            .select({ id: s.members.id })
            .from(s.members)
            .where(and(eq(s.members.userId, s.users.id), inArray(s.members.orgId, kept))),
        );

  const failures: unknown[] = [];
  for (const id of rows.orgIds) {
    if (kept.includes(id)) continue;
    await db
      .delete(s.organizations)
      .where(eq(s.organizations.id, id))
      .catch((e: unknown) => failures.push(e));
  }
  for (const id of new Set([...rows.userIds, ...signedIn])) {
    await db
      .delete(s.users)
      .where(and(eq(s.users.id, id), inKeptOrg && not(inKeptOrg)))
      .catch((e: unknown) => failures.push(e));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} test rows could not be removed`);
  }
}

/** Removes, after the file's last test, everything noted while it ran. */
export function cleanUpAfterAll(): void {
  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const rows = {
      orgIds: [...noted.orgs],
      userIds: [...noted.users],
      tgIds: [...noted.tgIds],
    };
    noted.orgs.clear();
    noted.users.clear();
    noted.tgIds.clear();
    await removeTestData(rows);
  });
}
