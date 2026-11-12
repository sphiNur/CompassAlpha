/**
 * What the orphaned-session repair (main.ts repairOrphanedSessions) does
 * with a session still `in_run` whose run is already terminal.
 *
 * 2026-10-21 audit CA-45: the sweep used to eject every orphan back to
 * `approved`, including sessions of a FINISHED run — whose goods were
 * bought and delivered — so they reappeared in the approval queue and
 * could be bundled into a second run. run.finish archives its sessions
 * (`Archived{reason:'run_finished'}` → status 'archived', run_id kept);
 * the repair now does the same for finished runs, with reason 'repair'.
 * Only a CANCELLED run's sessions go back to `approved`, as run.cancel
 * would have done.
 */
export type OrphanRepair =
  | {
      eventType: 'Archived';
      payload: { reason: 'repair' };
      /** Columns to set on read_model.order_sessions_v (plus last_seq/updated_at). */
      projection: { status: 'archived' };
    }
  | {
      eventType: 'EjectedFromRun';
      payload: { runId: string; byMemberId: null; reason: 'repair' };
      projection: { status: 'approved'; runId: null };
    };

/** Returns null when the run is not terminal (nothing to repair). */
export function orphanRepairFor(runStatus: string, runId: string): OrphanRepair | null {
  if (runStatus === 'finished') {
    return {
      eventType: 'Archived',
      payload: { reason: 'repair' },
      projection: { status: 'archived' },
    };
  }
  if (runStatus === 'cancelled') {
    return {
      eventType: 'EjectedFromRun',
      payload: { runId, byMemberId: null, reason: 'repair' },
      projection: { status: 'approved', runId: null },
    };
  }
  return null;
}
