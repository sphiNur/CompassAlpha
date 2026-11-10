/**
 * DLV-5 (2026-10-30 operation atlas): recalling a delivery told the store
 * nothing, and delivering again after a recall deduped into silence
 * because the delivered notification's key had no seq.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/delivery-recall-notify.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { emptyRunState, type RunEvent } from '@compass/domain/run';
import { dispatchRunEventNotifications } from '../services/notifyForEvent';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';

describe.skipIf(!SHOULD_RUN)('delivery recall notifications (PG-gated)', () => {
  test('deliver → recall → deliver again tells the store three times', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const [org] = await db
      .insert(s.organizations)
      .values({ slug: `recall-${suffix}`, name: 'Recall', localeDefault: 'en', timezone: 'UTC' })
      .returning();
    const orgId = org!.id;
    const [role] = await db
      .insert(s.roles)
      .values({ orgId, slug: 'staff', name: 'staff', rank: 10, isBuiltIn: true })
      .returning();
    await db.insert(s.permissions).values({ key: 'delivery.confirm', description: 'x' }).onConflictDoNothing();
    await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionKey: 'delivery.confirm' });
    const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `D-${suffix.slice(-6)}` }).returning();
    const [user] = await db
      .insert(s.users)
      .values({ displayName: 'Store staff', tgUserId: freshTgId() })
      .returning();
    const [member] = await db.insert(s.members).values({ orgId, userId: user!.id, status: 'active' }).returning();
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: member!.id, roleId: role!.id, scopeType: 'store', scopeId: store!.id });

    const runId = randomUUID();
    const base = (seq: number) => ({ streamId: runId, seq, occurredAt: new Date(), actorUserId: null, actorMemberId: null });
    const events = [
      { ...base(5), type: 'StoreDelivered', payload: { storeId: store!.id } },
      { ...base(6), type: 'StoreDeliveryUndone', payload: { storeId: store!.id, reason: '' } },
      { ...base(7), type: 'StoreDelivered', payload: { storeId: store!.id } },
    ] as unknown as RunEvent[];
    await withOrgContext(db, orgId, (tx) =>
      dispatchRunEventNotifications(tx, orgId, randomUUID(), emptyRunState(runId), events),
    );
    const rows = await db
      .select({ template: s.notifications.template, dedupKey: s.notifications.dedupKey })
      .from(s.notifications)
      .where(eq(s.notifications.orgId, orgId));
    const keysOf = (template: string) =>
      new Set(rows.filter((r) => r.template === template).map((r) => r.dedupKey)).size;
    // One key per channel; both deliveries got their own, as did the recall.
    const recalled = keysOf('run.storeDeliveryRecalled');
    expect(recalled).toBeGreaterThan(0);
    expect(keysOf('run.storeDelivered')).toBe(2 * recalled);
  });
});
