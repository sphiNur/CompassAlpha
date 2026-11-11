/**
 * Review ADM2-08 (2026-11-11): the one rule behind the maintenance lists'
 * per-row reasons and the deletes' refusals. Pure; the PG test in
 * apps/api/src/__tests__/purge-guards.test.ts checks that the lists and
 * the deletes read it the same way.
 */
import { describe, expect, test } from 'bun:test';
import {
  requirePurgeRole,
  runDeleteBlock,
  runDeleteRefusal,
  sessionDeleteBlock,
  sessionDeleteRefusal,
  type PurgeCaller,
  type RunFacts,
  type SessionFacts,
  type SessionToDelete,
} from '../purgeGuards';

const me: PurgeCaller = {
  orgId: 'org',
  userId: 'user-me',
  memberId: 'member-me',
  roleSlugs: new Set(['super_admin']),
};
const plainAdmin: PurgeCaller = { ...me, roleSlugs: new Set(['org-admin']) };
const guarded = { requireOnlyTestSessions: true };
const waived = { requireOnlyTestSessions: false };

const order = (values: Partial<SessionToDelete> = {}): SessionToDelete => ({
  id: 'order-1',
  status: 'submitted',
  runId: null,
  initiatedByMemberId: 'member-me',
  submittedByMemberId: 'member-me',
  ...values,
});
const orderFacts = (values: Partial<SessionFacts> = {}): SessionFacts => ({
  liveRunIds: new Set(),
  othersLines: new Set(),
  actedOn: new Set(),
  ...values,
});

describe('sessionDeleteBlock', () => {
  test("the caller's own test order may go", () => {
    expect(sessionDeleteBlock(order(), me, orderFacts(), guarded)).toBeNull();
  });

  test('only a super admin deletes, guard or no guard', () => {
    expect(sessionDeleteBlock(order(), plainAdmin, orderFacts(), guarded)).toBe('notSuperAdmin');
    expect(sessionDeleteBlock(order(), plainAdmin, orderFacts(), waived)).toBe('notSuperAdmin');
  });

  test('an order in a run goes with the run; one whose run is gone goes alone (CAT-4)', () => {
    const live = orderFacts({ liveRunIds: new Set(['run-1']) });
    expect(
      sessionDeleteBlock(order({ status: 'archived', runId: 'run-1' }), me, live, guarded),
    ).toBe('inRun');
    expect(sessionDeleteBlock(order({ runId: 'run-1' }), me, live, waived)).toBe('inRun');
    expect(sessionDeleteBlock(order({ status: 'in_run' }), me, orderFacts(), guarded)).toBe(
      'inRun',
    );
    expect(
      sessionDeleteBlock(order({ status: 'archived', runId: 'gone' }), me, live, guarded),
    ).toBeNull();
  });

  test("someone else's order, or the caller's with someone else's line in it (CAT-3)", () => {
    const facts = orderFacts();
    expect(sessionDeleteBlock(order({ submittedByMemberId: 'member-b' }), me, facts, guarded)).toBe(
      'othersOrder',
    );
    // Before it is submitted, the order is whoever started it.
    const started = order({ initiatedByMemberId: 'member-b', submittedByMemberId: null });
    expect(sessionDeleteBlock(started, me, facts, guarded)).toBe('othersOrder');
    // Once it is submitted, the submitter's.
    expect(
      sessionDeleteBlock(order({ initiatedByMemberId: 'member-b' }), me, facts, guarded),
    ).toBeNull();
    const theirLine = orderFacts({ othersLines: new Set(['order-1']) });
    expect(sessionDeleteBlock(order(), me, theirLine, guarded)).toBe('othersLines');
    expect(
      sessionDeleteBlock(order({ submittedByMemberId: 'member-b' }), me, theirLine, guarded),
    ).toBe('othersOrder');
  });

  test("the caller's own order that someone else acted on (R2-CAT-1)", () => {
    const facts = orderFacts({ actedOn: new Set(['order-1']) });
    expect(sessionDeleteBlock(order(), me, facts, guarded)).toBe('actedOnByOthers');
    expect(sessionDeleteBlock(order({ id: 'order-2' }), me, facts, guarded)).toBeNull();
  });

  test('the first reason wins, in the order the delete used to check them', () => {
    const everything = orderFacts({
      liveRunIds: new Set(['run-1']),
      othersLines: new Set(['order-1']),
      actedOn: new Set(['order-1']),
    });
    const theirs = order({ runId: 'run-1', submittedByMemberId: 'member-b' });
    expect(sessionDeleteBlock(theirs, plainAdmin, everything, guarded)).toBe('notSuperAdmin');
    expect(sessionDeleteBlock(theirs, me, everything, guarded)).toBe('inRun');
    expect(sessionDeleteBlock({ ...theirs, runId: null }, me, everything, guarded)).toBe(
      'othersOrder',
    );
  });

  test('without the guard, only the role and the run count', () => {
    const everything = orderFacts({
      othersLines: new Set(['order-1']),
      actedOn: new Set(['order-1']),
    });
    expect(
      sessionDeleteBlock(order({ submittedByMemberId: 'member-b' }), me, everything, waived),
    ).toBeNull();
  });
});

const run = { id: 'run-1', sessionIds: ['order-1', 'order-2'] };
const runFacts = (values: Partial<RunFacts> = {}): RunFacts => ({
  foreignSessions: new Set(),
  actedOnRuns: new Set(),
  actedOnSessions: new Set(),
  ...values,
});

describe('runDeleteBlock', () => {
  test("the caller's own test run may go", () => {
    expect(runDeleteBlock(run, me, runFacts(), guarded)).toBeNull();
    expect(runDeleteBlock({ id: 'run-2', sessionIds: [] }, me, runFacts(), guarded)).toBeNull();
  });

  test('only a super admin deletes, guard or no guard', () => {
    expect(runDeleteBlock(run, plainAdmin, runFacts(), guarded)).toBe('notSuperAdmin');
    expect(runDeleteBlock(run, plainAdmin, runFacts(), waived)).toBe('notSuperAdmin');
  });

  test("someone else's order in it", () => {
    const facts = runFacts({ foreignSessions: new Set(['order-2']) });
    expect(runDeleteBlock(run, me, facts, guarded)).toBe('foreignSessions');
  });

  test('someone else acted on the run, or on one of its orders (RE-CAT-1)', () => {
    expect(runDeleteBlock(run, me, runFacts({ actedOnRuns: new Set(['run-1']) }), guarded)).toBe(
      'actedOnByOthers',
    );
    expect(
      runDeleteBlock(run, me, runFacts({ actedOnSessions: new Set(['order-1']) }), guarded),
    ).toBe('actedOnByOthers');
    const elsewhere = runFacts({
      foreignSessions: new Set(['order-9']),
      actedOnRuns: new Set(['run-9']),
      actedOnSessions: new Set(['order-9']),
    });
    expect(runDeleteBlock(run, me, elsewhere, guarded)).toBeNull();
  });

  test("someone else's orders are named before what others did (R2-CAT-1)", () => {
    const both = runFacts({
      foreignSessions: new Set(['order-1']),
      actedOnRuns: new Set(['run-1']),
    });
    expect(runDeleteBlock(run, me, both, guarded)).toBe('foreignSessions');
    expect(runDeleteBlock(run, me, both, waived)).toBeNull();
  });
});

describe('what the deletes answer', () => {
  test('each reason has its error; the role is FORBIDDEN, the rest BAD_REQUEST', () => {
    expect(
      (['notSuperAdmin', 'inRun', 'othersOrder', 'othersLines', 'actedOnByOthers'] as const).map(
        (block) => {
          const err = sessionDeleteRefusal(block);
          return [err.code, err.message];
        },
      ),
    ).toEqual([
      ['FORBIDDEN', 'admin.errors.purgeRequiresSuperAdmin'],
      ['BAD_REQUEST', 'admin.errors.sessionAttachedToRun'],
      ['BAD_REQUEST', 'admin.errors.sessionHasForeignAuthors'],
      ['BAD_REQUEST', 'admin.errors.sessionHasForeignAuthors'],
      ['BAD_REQUEST', 'admin.errors.sessionActedOnByOthers'],
    ]);
    expect(
      (['notSuperAdmin', 'foreignSessions', 'actedOnByOthers'] as const).map((block) => {
        const err = runDeleteRefusal(block);
        return [err.code, err.message];
      }),
    ).toEqual([
      ['FORBIDDEN', 'admin.errors.purgeRequiresSuperAdmin'],
      ['BAD_REQUEST', 'admin.errors.runHasForeignSessions'],
      ['BAD_REQUEST', 'admin.errors.runActedOnByOthers'],
    ]);
  });

  test('requirePurgeRole refuses all but a super admin', () => {
    expect(() => requirePurgeRole(me)).not.toThrow();
    expect(() => requirePurgeRole(plainAdmin)).toThrow('admin.errors.purgeRequiresSuperAdmin');
  });
});
