import type { ConfirmStatus } from '@compass/contracts/schemas/delivery';
import type { CatalogKey } from '@compass/i18n';
import { labelIn, type Translate } from './table';

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

export function confirmStatusLabel(i18n: Translate, status: string | null | undefined): string {
  return labelIn(i18n, CONFIRM_STATUS, status);
}

export function deliveryStageLabel(i18n: Translate, stage: DeliveryStage): string {
  return i18n.t(DELIVERY_STAGE[stage]);
}
