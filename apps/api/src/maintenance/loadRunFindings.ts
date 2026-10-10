/**
 * Load every run's events and stored rows and say where they disagree.
 * Shared by the read-only report and the repair script so both act on
 * the same definition of "wrong".
 */
import { sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import type { RunEvent } from '@compass/domain/run';
import {
  analyseRun,
  hasDamage,
  type MovementRow,
  type RunFindings,
  type SplitRow,
} from './duplicatePurchases';

type Row = Record<string, unknown>;

function groupBy<T extends Row>(rows: T[], key: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = String(row[key]);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

export type LocatedFindings = RunFindings & { orgId: string; runDate: string; runIndex: number };

export interface FindingsReport {
  runsExamined: number;
  findings: LocatedFindings[];
  skuNames: Map<string, string>;
  storeNames: Map<string, string>;
}

/** Source tag on the compensating movements the repair script appends. */
export const CORRECTION_SOURCE = 'run_correction';

export async function loadRunFindings(tx: DB): Promise<FindingsReport> {
  const q = async <T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> =>
    (await tx.execute(query)) as unknown as T[];

  const runs = await q<{
    id: string;
    org_id: string;
    run_date: string;
    run_index: number;
    status: string;
  }>(sql`
        SELECT id::text, org_id::text, run_date::text, run_index, status
        FROM read_model.market_runs_v
        ORDER BY run_date, run_index`);
  const events = groupBy(
    await q(sql`
          SELECT stream_id::text, seq::int, occurred_at, actor_id::text AS actor_user_id, type, payload
          FROM domain.events
          WHERE stream_type = 'run'
          ORDER BY stream_id, seq`),
    'stream_id',
  );
  const splits = groupBy(
    await q(sql`
          SELECT run_id::text, sku_id::text, store_id::text, qty::text
          FROM read_model.run_item_stores_v`),
    'run_id',
  );
  const movements = groupBy(
    await q(sql`
          SELECT id::text, source_id::text AS run_id, sku_id::text, store_id::text, delta::text
          FROM inventory.movements
          WHERE source_type = 'run' AND reason = 'delivery_received'
            AND NOT EXISTS (
              SELECT 1 FROM inventory.movements c
              WHERE c.source_type = ${CORRECTION_SOURCE}
                AND c.source_id = inventory.movements.source_id
                AND c.store_id = inventory.movements.store_id
                AND c.sku_id = inventory.movements.sku_id
            )`),
    'run_id',
  );
  const skuNames = new Map(
    (
      await q<{ id: string; label: string }>(sql`
            SELECT id::text, COALESCE(names->>'en', names->>'zh', code, id::text) AS label
            FROM inventory.skus`)
    ).map((r) => [r.id, r.label]),
  );
  const storeNames = new Map(
    (await q<{ id: string; name: string }>(sql`SELECT id::text, name FROM inventory.stores`)).map(
      (r) => [r.id, r.name],
    ),
  );

  const findings: LocatedFindings[] = [];
  for (const run of runs) {
    const runEvents = (events.get(run.id) ?? []).map(
      (e) =>
        ({
          streamId: run.id,
          seq: e.seq,
          occurredAt: new Date(e.occurred_at as string),
          actorUserId: e.actor_user_id,
          actorMemberId: null,
          type: e.type,
          payload: e.payload,
        }) as unknown as RunEvent,
    );
    const found = analyseRun(
      run.id,
      runEvents,
      (splits.get(run.id) ?? []).map(
        (r): SplitRow => ({
          skuId: String(r.sku_id),
          storeId: String(r.store_id),
          qty: String(r.qty),
        }),
      ),
      (movements.get(run.id) ?? []).map(
        (r): MovementRow => ({
          id: String(r.id),
          skuId: String(r.sku_id),
          storeId: String(r.store_id),
          delta: String(r.delta),
        }),
      ),
    );
    if (found.rerecorded.length > 0 || hasDamage(found)) {
      findings.push({
        ...found,
        orgId: run.org_id,
        runDate: run.run_date,
        runIndex: run.run_index,
      });
    }
  }
  return { runsExamined: runs.length, findings, skuNames, storeNames };
}

export { hasDamage };
