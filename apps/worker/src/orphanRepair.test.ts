import { describe, expect, test } from 'bun:test';
import { orphanRepairFor } from './orphanRepair';

const RUN = '00000000-0000-0000-0000-0000000000aa';

describe('orphanRepairFor (2026-10-21 audit CA-45)', () => {
  test('a finished run archives its orphaned session, keeping run_id', () => {
    const r = orphanRepairFor('finished', RUN);
    expect(r).toEqual({
      eventType: 'Archived',
      payload: { reason: 'repair' },
      projection: { status: 'archived' },
    });
    // run_id must stay: the archived session still belongs to the run's history.
    expect(r && 'runId' in r.projection).toBe(false);
  });

  test('a cancelled run ejects its orphaned session back to approved', () => {
    expect(orphanRepairFor('cancelled', RUN)).toEqual({
      eventType: 'EjectedFromRun',
      payload: { runId: RUN, byMemberId: null, reason: 'repair' },
      projection: { status: 'approved', runId: null },
    });
  });

  test('a run that is not terminal is left alone', () => {
    for (const status of ['planned', 'purchasing', 'delivering', 'whatever']) {
      expect(orphanRepairFor(status, RUN)).toBeNull();
    }
  });
});
