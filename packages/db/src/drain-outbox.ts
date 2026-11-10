/**
 * One-shot — mark every still-pending sync.outbox row as sent.
 *
 * Used after the 2026-05-05 fake-data purge: events were wiped but the
 * outbox was missed, leaving notification jobs that pointed at deleted
 * users and burning worker cycles. With BOT_DELIVERY_ENABLED=false the
 * worker would have drained these on its own, but the cleaner approach
 * is to flush the queue once explicitly so logs stop filling
 * immediately.
 *
 *   bun run packages/db/src/drain-outbox.ts          # dry-run
 *   bun run packages/db/src/drain-outbox.ts --apply  # actually write
 */
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './index';
import { loadRepoEnv } from './repoEnv';

loadRepoEnv(import.meta.url);

const APPLY = process.argv.includes('--apply');

async function main() {
  const db = getDb(undefined, { system: 'maintenance' });
  const before = await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM sync.outbox WHERE sent_at IS NULL`),
  );
  const pending = (before as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  console.log(`Pending outbox rows: ${pending}`);
  if (pending === 0) {
    console.log('Nothing to drain.');
    await closeDb();
    return;
  }
  if (!APPLY) {
    console.log('DRY-RUN — re-run with --apply to mark all rows sent.');
    await closeDb();
    return;
  }
  await db.execute(
    sql.raw(`
      UPDATE sync.outbox
      SET sent_at = NOW(),
          last_error = 'drained as stale 2026-05-05'
      WHERE sent_at IS NULL
    `),
  );
  console.log(`✔ Drained ${pending} rows.`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  closeDb().finally(() => process.exit(1));
});
