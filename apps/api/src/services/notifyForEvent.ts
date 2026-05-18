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
            dedupKey: `order:${state.streamId}:submitted`,
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
      case 'Unapproved': {
        // M3.33 (2026-05-18, Wave1 #10): previously silent. Owner saw
        // their order revert from approved → submitted without a ping.
        await notifyOwner(db, orgId, state, actorUserId, {
          template: 'order.unapproved',
          title: 'Order returned for review',
          body:
            e.payload.reason ||
            'An approver reopened your order for review.',
          dedupKey: `order:${state.streamId}:unapproved`,
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
          body:
            e.payload.reason ??
            'The market run was cancelled. Pending arrivals will not happen.',
          dedupKey: `run:${state.streamId}:cancelled`,
          payload: { runId: state.streamId, reason: e.payload.reason },
          deepLink: '/run',
        });
        break;
      }
      // Run events still without notifications:
      //   PurchaseStarted, ItemPurchased, ItemUnavailable, DeliveryStarted,
      //   StoreItemConfirmed, StoreConfirmed
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
  envelope: {
    template: string;
    title: string;
    body: string;
    dedupKey: string;
    deepLink?: string;
    payload?: Record<string, unknown>;
  },
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
