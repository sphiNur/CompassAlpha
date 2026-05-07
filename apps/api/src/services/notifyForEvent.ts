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
import type { OrderEvent, OrderState } from '@compass/domain/order';
import type { RunEvent, RunState } from '@compass/domain/run';
import { dispatch, findStoreStaff, notifyOthersWithPermission } from './notify';

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
        await notifyOthersWithPermission(db, orgId, 'order.approve', actorUserId, {
          template: 'order.submitted',
          title: 'Order submitted',
          body: 'A staff submitted an order awaiting your review.',
          dedupKey: `order:${state.streamId}:submitted`,
          payload: { sessionId: state.streamId, storeId: state.storeId },
          deepLink: '/approve',
        });
        break;
      }
      case 'Approved': {
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.approved',
          title: 'Order approved',
          body: 'Your order is approved and queued for the next market run.',
          dedupKey: `order:${state.streamId}:approved`,
          deepLink: '/order',
        });
        break;
      }
      case 'Rejected': {
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.rejected',
          title: 'Order rejected',
          body: e.payload.reason || 'Your order was rejected; please update and resubmit.',
          dedupKey: `order:${state.streamId}:rejected`,
          deepLink: '/order',
          payload: { reason: e.payload.reason },
        });
        break;
      }
      // Order events without notifications:
      //   DraftStarted, ItemAdjusted, ItemNoteSet, Claimed, ClaimReleased,
      //   Withdrawn, Unapproved, AttachedToRun, EjectedFromRun, Archived
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
            dedupKey: `run:${state.streamId}:store:${e.payload.storeId}:delivered`,
            payload: { runId: state.streamId, storeId: e.payload.storeId },
            deepLink: '/confirm',
          });
        }
        break;
      }
      case 'RunFinished': {
        if (state.purchaserMemberId) {
          const member = await db.query.members.findFirst({
            where: (m, { eq }) => eq(m.id, state.purchaserMemberId!),
          });
          if (member && member.userId !== actorUserId) {
            await dispatch(db, orgId, [member.userId], {
              template: 'run.finished',
              title: 'Run finished',
              body: `Run complete · total ${e.payload.totalActual}.`,
              dedupKey: `run:${state.streamId}:finished`,
              payload: { runId: state.streamId, totalActual: e.payload.totalActual },
              deepLink: '/run',
            });
          }
        }
        break;
      }
      // Run events without notifications:
      //   PurchaseStarted, ItemPurchased, ItemUnavailable, DeliveryStarted,
      //   StoreItemConfirmed, StoreConfirmed, RunCancelled
      default:
        break;
    }
  }
}

/**
 * Notify "the people waiting on this decision". In the per-store model
 * the right recipients are everyone who contributed a line to the order:
 * the submitter plus anyone whose line is still in the bag. We ping
 * each distinct member exactly once. Falls back to the initiator if no
 * line authorship is available.
 */
async function notifyOwner(
  db: DB,
  orgId: string,
  state: OrderState,
  actorUserId: string,
  envelope: {
    template: string;
    title: string;
    body: string;
    dedupKey: string;
    deepLink?: string;
    payload?: Record<string, unknown>;
  },
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

  const memberRows = await db.query.members.findMany({
    where: (m, { inArray }) => inArray(m.id, [...memberIds]),
  });
  const userIds = memberRows
    .map((m) => m.userId)
    .filter((uid) => uid !== actorUserId);
  if (userIds.length === 0) return;
  await dispatch(db, orgId, [...new Set(userIds)], envelope);
}
