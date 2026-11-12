/**
 * Order and run streams written from domain commands, for the API tests
 * that need a session or a run in a given state (review TEST1-04,
 * 2026-11). `write` applies the events, appends them and projects them in
 * one organisation transaction on the server's handle, as the routers do;
 * the projections' inserts are held to the tenant policies.
 */
import { randomUUID } from 'node:crypto';
import { getDb, withOrgContext } from '@compass/db';
import {
  apply as applyOrder,
  decide as decideOrder,
  emptyState as emptyOrderState,
  type ActorCtx as OrderActor,
  type OrderCommand,
  type OrderEvent,
  type OrderState,
} from '@compass/domain/order';
import {
  applyRun,
  decideRun,
  emptyRunState,
  type RunCommand,
  type RunEvent,
  type RunState,
} from '@compass/domain/run';
import { appendEvents } from '../../services/eventStore';
import { projectOrder } from '../../services/orderProjection';
import { projectRun } from '../../services/runProjection';

export interface Stream<Command, Event, State> {
  readonly id: string;
  readonly state: State;
  /** Decides `command` against the current state and writes what it emits. */
  exec(command: Command): Promise<Event[]>;
  /** Applies, appends and projects `events`; nothing for none. */
  write(events: Event[]): Promise<void>;
}

export type OrderStream = Stream<OrderCommand, OrderEvent, OrderState>;
export type RunStream = Stream<RunCommand, RunEvent, RunState>;

export function orderStream(orgId: string, id: string = randomUUID()): OrderStream {
  let state = emptyOrderState(id);
  const write = async (events: OrderEvent[]) => {
    if (events.length === 0) return;
    for (const e of events) state = applyOrder(state, e);
    await withOrgContext(getDb(), orgId, async (tx) => {
      await appendEvents(tx, {
        streamType: 'order',
        streamId: id,
        orgId,
        events: events.map((e) => ({ ...e })),
      });
      await projectOrder(tx, orgId, events);
    });
  };
  return {
    id,
    get state() {
      return state;
    },
    async exec(command) {
      const events = decideOrder(state, command);
      await write(events);
      return events;
    },
    write,
  };
}

export function runStream(orgId: string, id: string = randomUUID()): RunStream {
  let state = emptyRunState(id);
  const write = async (events: RunEvent[]) => {
    if (events.length === 0) return;
    for (const e of events) state = applyRun(state, e);
    await withOrgContext(getDb(), orgId, async (tx) => {
      await appendEvents(tx, {
        streamType: 'run',
        streamId: id,
        orgId,
        events: events.map((e) => ({ ...e })),
      });
      await projectRun(tx, orgId, events);
    });
  };
  return {
    id,
    get state() {
      return state;
    },
    async exec(command) {
      const events = decideRun(state, command);
      await write(events);
      return events;
    },
    write,
  };
}

let runIndex = 0;

/**
 * Starts `run` with RunPlanned, for today (UTC) unless `runDate` says
 * otherwise. Written directly rather than decided from PlanRun, which
 * refuses a plan without orders: some fixture runs have none. Each run
 * gets an index of its own unless `runIndex` is given, as one run per
 * day and index is allowed.
 */
export async function planRun(
  run: RunStream,
  orgId: string,
  plan: {
    by: { userId: string; memberId: string };
    sessionIds: string[];
    plannedItems: Array<{ skuId: string; qty: string }>;
    /** Defaults to `by`. */
    purchaserMemberId?: string;
    runDate?: string;
    runIndex?: number;
  },
): Promise<void> {
  await run.write([
    {
      streamId: run.id,
      seq: 1,
      occurredAt: new Date(),
      actorUserId: plan.by.userId,
      actorMemberId: plan.by.memberId,
      type: 'RunPlanned',
      payload: {
        orgId,
        runDate: plan.runDate ?? new Date().toISOString().slice(0, 10),
        runIndex: plan.runIndex ?? runIndex++,
        sessionIds: plan.sessionIds,
        plannedItems: plan.plannedItems,
        purchaserMemberId: plan.purchaserMemberId ?? plan.by.memberId,
      },
    } satisfies RunEvent,
  ]);
}

export interface SeedOrderOptions {
  storeId: string;
  /** What the order asks for, each in kg. */
  items: ReadonlyArray<{ skuId: string; qty: string }>;
  /** Free-text lines, named "extra 0", "extra 1", … (1 kg each). */
  extras?: number;
  /** Who claims it once it is submitted. */
  claimedBy?: OrderActor;
  /** How far it goes after Submit: no further (default), Approve, or AttachToRun. */
  until?: 'submitted' | 'approved' | { runId: string };
}

let orderDay = 0;

/**
 * An order drafted by `author` on a past day of its own (one draft per
 * person, store and day) and submitted, then taken as far as `until`.
 * Returns its session id.
 */
export async function seedOrder(
  orgId: string,
  author: OrderActor,
  options: SeedOrderOptions,
): Promise<string> {
  const order = orderStream(orgId);
  orderDay += 1;
  const orderDate = new Date(Date.UTC(2025, 0, orderDay)).toISOString().slice(0, 10);
  await order.exec({
    type: 'StartDraft',
    orgId,
    storeId: options.storeId,
    orderDate,
    actor: author,
  });
  for (const { skuId, qty } of options.items) {
    await order.exec({
      type: 'AdjustItem',
      skuId,
      qty,
      sku: { id: skuId, step: '1', unit: 'kg', isArchived: false },
      actor: author,
    });
  }
  if (options.extras) {
    await order.exec({
      type: 'SetSessionExtras',
      extras: Array.from({ length: options.extras }, (_, i) => ({
        name: `extra ${i}`,
        qty: '1',
        unit: 'kg',
      })),
      actor: author,
    });
  }
  await order.exec({ type: 'Submit', actor: author });
  if (options.claimedBy) await order.exec({ type: 'Claim', actor: options.claimedBy });
  const until = options.until ?? 'submitted';
  if (until === 'submitted') return order.id;
  await order.exec({ type: 'Approve', actor: author });
  if (until === 'approved') return order.id;
  await order.exec({ type: 'AttachToRun', runId: until.runId, actor: author });
  return order.id;
}
