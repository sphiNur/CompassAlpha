/**
 * The orphaned-session repair (main.ts repairOrphanedSessions) for one
 * session still `in_run` whose run is already terminal.
 *
 * 2026-10-21 audit CA-45: the sweep used to eject every orphan back to
 * `approved`, including sessions of a FINISHED run — whose goods were
 * bought and delivered — so they reappeared in the approval queue and
 * could be bundled into a second run. run.finish archives its sessions
 * (`Archived{reason:'run_finished'}` → status 'archived', run_id kept);
 * the repair now does the same for finished runs, with reason 'repair'.
 * Only a CANCELLED run's sessions go back to `approved`, as run.cancel
 * would have done.
 *
 * Review ORD-07: the domain decides the repair (`RepairOrphan`) from the
 * session's stream and the API's projector writes it; the worker used to
 * build the event and the read-model update itself.
 */
import { sql } from 'drizzle-orm';
import { notifyRealtime, type DB } from '@compass/db';
import { decideSystem, type OrderEvent } from '@compass/domain/order';
import { loadOrderState, writeOrderEvents } from '@compass/streams';

/**
 * Repair `session` in the caller's transaction. Returns the event written,
 * or null when there was nothing to repair: another transaction may have
 * ejected or archived the session since the candidate scan.
 */
export async function repairOrphanedSession(
  tx: DB,
  session: { id: string; orgId: string },
): Promise<OrderEvent['type'] | null> {
  // The run's status is not in the session's stream: read it with the
  // session row, locked.
  const [cur] = (await tx.execute(sql`
    SELECT sess.status, sess.run_id, run.status AS run_status
    FROM read_model.order_sessions_v sess
    LEFT JOIN read_model.market_runs_v run ON run.id = sess.run_id
    WHERE sess.id = ${session.id}
    FOR UPDATE OF sess
  `)) as unknown as Array<{ status: string; run_id: string | null; run_status: string | null }>;
  if (!cur || cur.status !== 'in_run' || !cur.run_id) return null;
  if (cur.run_status !== 'finished' && cur.run_status !== 'cancelled') return null;

  const events = decideSystem(await loadOrderState(tx, session.id), {
    type: 'RepairOrphan',
    runId: cur.run_id,
    runStatus: cur.run_status,
  });
  const repair = events.at(-1);
  if (!repair) return null;
  await writeOrderEvents(tx, session.orgId, session.id, events);
  // Open pages refresh once this commits (B14).
  await notifyRealtime(tx, {
    type: 'order.changed',
    orgId: session.orgId,
    sessionId: session.id,
    lastSeq: repair.seq,
  });
  return repair.type;
}
