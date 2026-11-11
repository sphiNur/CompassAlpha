/**
 * UI-2: a status is shown in the reader's language, from one place. Each
 * table names the catalog key for every value its status can take, so a
 * value added to the enum fails type-check here; a value this build does
 * not know (a newer server) reads as "unknown status", never as the raw
 * value or a key.
 *
 * Review RUNWEB1-26, ADM2-16 and COREWEB1-31 (2026-11-12): the keys were
 * composed from strings and cast at each call site, which turned the key
 * check off, and the run's step was mapped twice in RunPage, one of them
 * falling back to the raw status.
 */
import type { SubscriptionStatus } from '@compass/contracts/schemas/auth';
import type { ConfirmStatus } from '@compass/contracts/schemas/delivery';
import type { OrderStatus } from '@compass/contracts/schemas/order';
import type { RunStatus } from '@compass/contracts/schemas/run';
import type { CatalogKey, I18n } from '@compass/i18n';

type Translate = Pick<I18n, 't'>;

/**
 * ORD-18 (2026-10-30): a rejected order reads "Rejected" alone;
 * `order.status.rejected` carries the reason, for the order's banner.
 */
const ORDER_STATUS: Record<OrderStatus, CatalogKey> = {
  draft: 'order.status.draft',
  submitted: 'order.status.submitted',
  approved: 'order.status.approved',
  rejected: 'order.status.rejectedTitle',
  in_run: 'order.status.in_run',
  archived: 'order.status.archived',
};

const RUN_STATUS: Record<RunStatus, CatalogKey> = {
  planned: 'run.status.planned',
  purchasing: 'run.status.purchasing',
  delivering: 'run.status.delivering',
  finished: 'run.status.finished',
  amending: 'run.status.amending',
  cancelled: 'run.status.cancelled',
};

/** RE-COPY-1: the step a run is at, as the run switcher names it. */
const RUN_STEP: Record<RunStatus, CatalogKey> = {
  planned: 'run.step.plan',
  purchasing: 'run.step.purchase',
  delivering: 'run.step.deliver',
  finished: 'run.step.done',
  amending: 'run.step.amend',
  cancelled: 'run.status.cancelled',
};

/** The store's receiving verdict on a line. */
const CONFIRM_STATUS: Record<ConfirmStatus, CatalogKey> = {
  ok: 'confirm.status.ok',
  short: 'confirm.status.short',
  wrong: 'confirm.status.wrong',
  quality: 'confirm.status.quality',
};

/** A store's goods in a run: not delivered yet, delivered, received. */
export type DeliveryStage = 'pending' | 'delivered' | 'confirmed';

const DELIVERY_STAGE: Record<DeliveryStage, CatalogKey> = {
  pending: 'run.deliveryStage.pending',
  delivered: 'run.deliveryStage.delivered',
  confirmed: 'run.deliveryStage.confirmed',
};

const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, CatalogKey> = {
  trialing: 'subscription.status.trialing',
  active: 'subscription.status.active',
  past_due: 'subscription.status.past_due',
  suspended: 'subscription.status.suspended',
  canceled: 'subscription.status.canceled',
};

function isIn<S extends string>(table: Record<S, CatalogKey>, value: string): value is S {
  // Not Object.hasOwn: older iOS WebViews lack it, and nothing polyfills it.
  return Object.prototype.hasOwnProperty.call(table, value);
}

function keyIn<S extends string>(
  table: Record<S, CatalogKey>,
  status: string | null | undefined,
): CatalogKey {
  return status != null && isIn(table, status) ? table[status] : 'common.unknownStatus';
}

export function orderStatusLabel(i18n: Translate, status: string | null | undefined): string {
  return i18n.t(keyIn(ORDER_STATUS, status));
}

export function runStatusLabel(i18n: Translate, status: string | null | undefined): string {
  return i18n.t(keyIn(RUN_STATUS, status));
}

export function runStepLabel(i18n: Translate, status: string | null | undefined): string {
  return i18n.t(keyIn(RUN_STEP, status));
}

export function confirmStatusLabel(i18n: Translate, status: string | null | undefined): string {
  return i18n.t(keyIn(CONFIRM_STATUS, status));
}

export function deliveryStageLabel(i18n: Translate, stage: DeliveryStage): string {
  return i18n.t(DELIVERY_STAGE[stage]);
}

export function subscriptionStatusLabel(
  i18n: Translate,
  status: string | null | undefined,
): string {
  return i18n.t(keyIn(SUBSCRIPTION_STATUS, status));
}
