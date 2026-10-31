/**
 * Single source of truth for "domain event → notification". Order/Run
 * routers used to inline this logic; consolidating means new event
 * types only need a single switch entry, and the dispatch path is the
 * same shape for every aggregate.
 *
 * Keep the work inside the same tx as the projection so notification
 * rows are visible the instant the read model is. The `outbox` row
 * is read by `apps/worker` once committed.
 */
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import { eq } from 'drizzle-orm';
import type { OrderEvent, OrderState } from '@compass/domain/order';
import type { RunEvent, RunState } from '@compass/domain/run';
import {
  dispatch,
  type NotifyEnvelope,
  findRecipientsByPermissionInStore,
  findStoreStaff,
  notifyOthersWithPermission,
} from './notify';

export async function dispatchOrderEventNotifications(
  db: DB,
  orgId: string,
  actorUserId: string,
  state: OrderState,
  events: OrderEvent[],
): Promise<void> {
  for (const e of events) {
    switch (e.type) {
      case 'Submitted': {
        // 2026-10-21 audit CA-31/F-04: dedupKeys for Submitted, Approved,
        // Rejected and Unapproved carry the event seq (as Withdrawn already
        // did). Without it a resubmission after a rejection, or a second
        // approval after an unapprove, hit the earlier row's dedup key and
        // the inbox swallowed a legitimate notification. Replays of the
        // same event keep the same seq, so they still dedup.
        // M3.6 (2026-05-15): scope the recipient set to managers of
        // THIS order's store. Before the fix the call returned every
        // user in the org with `order.approve`, so a manager bound
        // to a different store would be notified about activity they
        // had no authority over — an info leak about that store's
        // submission rate, contributor, and SKU mix.
        // Global bindings (admin/super_admin overseeing the chain)
        // still receive the notification via the OR-on-global clause
        // inside findRecipientsByPermissionInStore.
        //
        // OrderState.storeId is nullable in the type but a Submitted
        // event implies it's set (you can't submit before StartDraft
        // pinned a store). The undefined fallback degrades safely to
        // org-wide if a malformed state ever shows up — better than
        // silently skipping the notification entirely.
        await notifyOthersWithPermission(
          db,
          orgId,
          'order.approve',
          actorUserId,
          {
            template: 'order.submitted',
            title: 'Order submitted',
            body: 'A staff submitted an order awaiting your review.',
            vars: { store: await storeName(db, state.storeId) },
            dedupKey: `order:${state.streamId}:submitted:${e.seq}`,
            payload: { sessionId: state.streamId, storeId: state.storeId },
            deepLink: '/approve',
          },
          { storeId: state.storeId ?? undefined },
        );
        break;
      }
      case 'Approved': {
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.approved',
          title: 'Order approved',
          body: 'Your order is approved and queued for the next market run.',
          dedupKey: `order:${state.streamId}:approved:${e.seq}`,
          deepLink: '/order',
        });
        // APR-6 (2026-10-30, owner decision): approving one's own order
        // stays allowed (a store often has one manager), but the store's
        // other approvers hear about it. With none, nobody is told.
        if (state.submittedByMemberId && state.submittedByMemberId === e.payload.byMemberId) {
          await notifyOthersWithPermission(
            db,
            orgId,
            'order.approve',
            actorUserId,
            {
              template: 'order.selfApproved',
              title: 'Order approved by its submitter',
              body: 'A manager approved an order they submitted themselves.',
              vars: { store: await storeName(db, state.storeId) },
              dedupKey: `order:${state.streamId}:selfApproved:${e.seq}`,
              payload: { sessionId: state.streamId, storeId: state.storeId },
              deepLink: '/approve',
            },
            { storeId: state.storeId ?? undefined },
          );
        }
        break;
      }
      case 'Rejected': {
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.rejected',
          title: 'Order rejected',
          body: 'Your order was rejected; please update and resubmit.',
          reason: e.payload.reason || null,
          dedupKey: `order:${state.streamId}:rejected:${e.seq}`,
          deepLink: '/order',
          payload: { reason: e.payload.reason },
        });
        break;
      }
      case 'ClaimReleased': {
        // D13 / APR-13 (2026-10-31): the approver whose claim another one
        // took over is told so, in the app only (no Telegram message).
        const p = e.payload as { reason?: string; fromMemberId?: string; byMemberId?: string };
        if (p.reason === 'override' && p.fromMemberId) {
          await notifyClaimLost(db, orgId, p.fromMemberId, {
            template: 'order.claimTakenOver',
            title: 'Your review was taken over',
            body: 'Another reviewer took over an order you were reviewing.',
            dedupKey: `order:${state.streamId}:claimTakenOver:${e.seq}`,
            deepLink: '/approve',
            payload: {
              sessionId: state.streamId,
              storeId: state.storeId,
              byMemberId: p.byMemberId,
            },
          });
        }
        break;
      }
      case 'Unapproved': {
        // M3.33 (2026-05-18, Wave1 #10): previously silent. Owner saw
        // their order revert from approved → submitted without a ping.
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.unapproved',
          title: 'Order returned for review',
          body: 'An approver reopened your order for review.',
          reason: e.payload.reason || null,
          dedupKey: `order:${state.streamId}:unapproved:${e.seq}`,
          deepLink: '/order',
          payload: { reason: e.payload.reason },
        });
        break;
      }
      case 'Withdrawn': {
        // M3.33: managers can override-withdraw a submitted order
        // (commands.ts:393 `order.approve` branch). When that happens
        // the owner needs to know their order is back to draft. Skipped
        // when the actor IS the submitter (self-withdraw — they did it).
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.withdrawn',
          title: 'Order returned to draft',
          body: 'A manager pulled your submitted order back to draft.',
          dedupKey: `order:${state.streamId}:withdrawn:${e.seq}`,
          deepLink: '/order',
        });
        break;
      }
      case 'AttachedToRun': {
        // M3.33: tell the submitter their order is now in a market run.
        // Closes the "I submitted, waited, then never heard back" gap.
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.attachedToRun',
          title: 'Order moved to a market run',
          body: 'Your order is now being purchased.',
          dedupKey: `order:${state.streamId}:attachedToRun:${e.payload.runId}`,
          deepLink: '/order',
          payload: { runId: e.payload.runId },
        });
        break;
      }
      // Order events still without notifications:
      //   DraftStarted, ItemAdjusted, ItemNoteSet, Claimed, ClaimReleased,
      //   EjectedFromRun, Archived
      default:
        break;
    }
  }
}

export async function dispatchRunEventNotifications(
  db: DB,
  orgId: string,
  actorUserId: string,
  state: RunState,
  events: RunEvent[],
): Promise<void> {
  for (const e of events) {
    switch (e.type) {
      case 'RunPlanned': {
        await notifyOthersWithPermission(db, orgId, 'run.purchase', actorUserId, {
          template: 'run.planned',
          title: 'New market run planned',
          body: 'A purchaser bundled approved sessions; ready to start buying.',
          dedupKey: `run:${state.streamId}:planned`,
          payload: { runId: state.streamId, runDate: state.runDate, runIndex: state.runIndex },
          deepLink: '/run',
        });
        break;
      }
      case 'StoreDelivered': {
        const recipients = await findStoreStaff(db, orgId, e.payload.storeId);
        const targets = recipients.filter((u) => u !== actorUserId);
        if (targets.length > 0) {
          await dispatch(db, orgId, targets, {
            template: 'run.storeDelivered',
            title: 'Delivery arrived',
            body: 'Items have been delivered to your store — please confirm.',
            vars: { store: await storeName(db, e.payload.storeId) },
            // DLV-5 (2026-10-30): with the seq, a delivery made again after
            // a recall notifies again instead of deduping into silence.
            dedupKey: `run:${state.streamId}:store:${e.payload.storeId}:delivered:${e.seq}`,
            payload: { runId: state.streamId, storeId: e.payload.storeId },
            deepLink: '/confirm',
          });
        }
        break;
      }
      case 'StoreDeliveryUndone': {
        // DLV-5: the recall dialog says the store is told; it was not.
        const recipients = await findStoreStaff(db, orgId, e.payload.storeId);
        const targets = recipients.filter((u) => u !== actorUserId);
        if (targets.length > 0) {
          await dispatch(db, orgId, targets, {
            template: 'run.storeDeliveryRecalled',
            title: 'Delivery recalled',
            body: 'The purchaser recalled this delivery. Wait until it is delivered again before confirming.',
            vars: { store: await storeName(db, e.payload.storeId) },
            dedupKey: `run:${state.streamId}:store:${e.payload.storeId}:recalled:${e.seq}`,
            payload: { runId: state.streamId, storeId: e.payload.storeId },
            deepLink: '/confirm',
          });
        }
        break;
      }
      case 'StoreConfirmed': {
        // 2026-10-21 CA-06: a store signed for goods with at least one
        // short / wrong / quality line. Before this the issue lived only
        // in run_item_stores_v and vanished from every screen once the
        // run finished. Tell the run's purchaser(s) and the store's
        // managers. dedupKey carries the seq — a store can only confirm
        // once per run, but a replay of the same event still dedups.
        const store = state.stores.get(e.payload.storeId);
        const issues = [...(store?.itemConfirms.entries() ?? [])].filter(
          ([, c]) => c.status !== 'ok',
        );
        if (issues.length === 0) break;
        const recipients = new Set<string>();
        const purchaserMemberIds = [state.purchaserMemberId, state.claimedByMemberId].filter(
          (id): id is string => !!id,
        );
        if (purchaserMemberIds.length > 0) {
          const members = await db.query.members.findMany({
            where: (m, { inArray, and, eq }) =>
              and(inArray(m.id, purchaserMemberIds), eq(m.status, 'active')),
          });
          for (const m of members) recipients.add(m.userId);
        }
        for (const u of await findRecipientsByPermissionInStore(
          db,
          orgId,
          'order.approve',
          e.payload.storeId,
        )) {
          recipients.add(u);
        }
        recipients.delete(actorUserId);
        if (recipients.size === 0) break;
        await dispatch(db, orgId, [...recipients], {
          template: 'run.storeConfirmedWithIssues',
          title: 'Delivery received with problems',
          body: `A store confirmed delivery with ${issues.length} problem item(s) — please review.`,
          vars: { store: await storeName(db, e.payload.storeId), n: issues.length },
          dedupKey: `run:${state.streamId}:store:${e.payload.storeId}:issues:${e.seq}`,
          payload: {
            runId: state.streamId,
            storeId: e.payload.storeId,
            issues: issues.map(([skuId, c]) => ({
              skuId,
              status: c.status,
              receivedQty: c.receivedQty ?? null,
              note: c.note,
            })),
          },
          deepLink: '/run',
        });
        break;
      }
      case 'RunFinished': {
        // 2026-10-21 CA-11: the amount is the one purchase-money figure —
        // items + expenses — shown as its parts. totalActual stays the
        // items-only figure; events from before itemsTotal/expensesTotal
        // existed fall back to totalActual and the state's expenses.
        const itemsTotal = Number(e.payload.itemsTotal ?? e.payload.totalActual);
        const expensesTotal =
          e.payload.expensesTotal !== undefined
            ? Number(e.payload.expensesTotal)
            : state.expenses.reduce((sum, x) => sum + Number(x.qty) * Number(x.unitPrice), 0);
        const grandTotal = (itemsTotal + expensesTotal).toFixed(2);
        if (state.purchaserMemberId) {
          // 2026-10-21 audit CA-31/F-07: suspended members get nothing.
          const member = await db.query.members.findFirst({
            where: (m, { eq, and }) =>
              and(eq(m.id, state.purchaserMemberId!), eq(m.status, 'active')),
          });
          if (member && member.userId !== actorUserId) {
            await dispatch(db, orgId, [member.userId], {
              template: 'run.finished',
              title: 'Run finished',
              body:
                `Run complete · items ${itemsTotal.toFixed(2)} · expenses ` +
                `${expensesTotal.toFixed(2)} · total ${grandTotal}.`,
              vars: {
                items: itemsTotal.toFixed(2),
                expenses: expensesTotal.toFixed(2),
                total: grandTotal,
              },
              dedupKey: `run:${state.streamId}:finished`,
              payload: {
                runId: state.streamId,
                totalActual: e.payload.totalActual,
                itemsTotal: itemsTotal.toFixed(2),
                expensesTotal: expensesTotal.toFixed(2),
                total: grandTotal,
              },
              deepLink: '/run',
            });
          }
        }
        // M3.33 (2026-05-18, Wave1 #10): also notify the involved store
        // staff that the run is closed — useful audit signal ("today's
        // procurement done, no more arrivals coming") and matches the
        // operator's mental model of finish = "everything that was
        // going to arrive has arrived".
        await notifyInvolvedStoreStaff(db, orgId, state, actorUserId, {
          template: 'run.finishedStore',
          title: 'Run finished',
          body: 'Today\'s market run is closed — no further deliveries from this run.',
          dedupKey: `run:${state.streamId}:finished:storeStaff`,
          payload: { runId: state.streamId },
          deepLink: '/confirm',
        });
        break;
      }
      case 'RunCancelled': {
        // M3.33: cancellation flipped silent before — store staff who
        // got a "delivery arrived" ping moments earlier had no clue
        // the whole run was scrapped, and might confirm receipt
        // against a cancelled run. Notify everyone touched by the run.
        await notifyInvolvedStoreStaff(db, orgId, state, actorUserId, {
          template: 'run.cancelled',
          title: 'Run cancelled',
          body: 'The market run was cancelled. Pending arrivals will not happen.',
          reason: e.payload.reason ?? null,
          dedupKey: `run:${state.streamId}:cancelled`,
          payload: { runId: state.streamId, reason: e.payload.reason },
          deepLink: '/run',
        });
        break;
      }
      // Run events still without notifications:
      //   PurchaseStarted, ItemPurchased, ItemUnavailable, DeliveryStarted,
      //   StoreItemConfirmed, StoreConfirmed without problem lines
      default:
        break;
    }
  }
}

/**
 * Fan out a notification to every store staff member touched by a run
 * (across all sessions in the run's session list). Used by run-level
 * lifecycle events (RunCancelled, RunFinished) where the store-staff
 * who got the "delivery arrived" ping need a matching closing event.
 *
 * Skips the actor — the person who ran the command doesn't need to be
 * told their own action just happened.
 */
async function notifyInvolvedStoreStaff(
  db: DB,
  orgId: string,
  state: RunState,
  actorUserId: string,
  envelope: NotifyEnvelope,
): Promise<void> {
  if (state.sessionIds.length === 0) return;
  const sessions = await db.query.orderSessionsV.findMany({
    where: (sess, { inArray }) => inArray(sess.id, state.sessionIds),
    columns: { storeId: true },
  });
  const storeIds = [...new Set(sessions.map((s) => s.storeId))];
  if (storeIds.length === 0) return;
  const allUserIds = new Set<string>();
  for (const storeId of storeIds) {
    const recipients = await findStoreStaff(db, orgId, storeId);
    for (const u of recipients) {
      if (u !== actorUserId) allUserIds.add(u);
    }
  }
  if (allUserIds.size === 0) return;
  await dispatch(db, orgId, [...allUserIds], envelope);
}

/**
 * Notify "the people waiting on this decision". In the per-store model
 * the right recipients are everyone who contributed a line to the order:
 * the submitter plus anyone whose line is still in the bag. We ping
 * each distinct member exactly once. Falls back to the initiator if no
 * line authorship is available.
 */
/** D13: one in-app notification to the member who lost a claim. */
async function notifyClaimLost(
  db: DB,
  orgId: string,
  memberId: string,
  envelope: NotifyEnvelope,
): Promise<void> {
  const member = await db.query.members.findFirst({
    where: (m, { and, eq }) => and(eq(m.id, memberId), eq(m.orgId, orgId), eq(m.status, 'active')),
  });
  if (!member) return;
  await dispatch(db, orgId, [member.userId], envelope, ['inapp']);
}

async function notifyOwner(
  db: DB,
  orgId: string,
  state: OrderState,
  actorUserId: string,
  envelope: NotifyEnvelope,
): Promise<void> {
  const memberIds = new Set<string>();
  for (const item of state.items.values()) {
    if (item.contributorMemberId) memberIds.add(item.contributorMemberId);
  }
  if (state.submittedByMemberId) memberIds.add(state.submittedByMemberId);
  if (memberIds.size === 0 && state.initiatedByMemberId) {
    memberIds.add(state.initiatedByMemberId);
  }
  if (memberIds.size === 0) return;

  // 2026-10-21 audit CA-31/F-07: suspended members get nothing.
  const memberRows = await db.query.members.findMany({
    where: (m, { inArray, and, eq }) =>
      and(inArray(m.id, [...memberIds]), eq(m.status, 'active')),
  });
  const userIds = memberRows
    .map((m) => m.userId)
    .filter((uid) => uid !== actorUserId);
  if (userIds.length === 0) return;
  await dispatch(db, orgId, [...new Set(userIds)], envelope);
}

/** A store's name for a notification sentence; '' when it is gone. */
async function storeName(db: DB, storeId: string | null | undefined): Promise<string> {
  if (!storeId) return '';
  const [row] = await db
    .select({ name: s.stores.name })
    .from(s.stores)
    .where(eq(s.stores.id, storeId))
    .limit(1);
  return row?.name ?? '';
}
