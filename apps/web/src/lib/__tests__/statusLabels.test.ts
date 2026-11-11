import { beforeAll, describe, expect, test } from 'bun:test';
import { SubscriptionStatusSchema } from '@compass/contracts/schemas/auth';
import { ConfirmStatusSchema } from '@compass/contracts/schemas/delivery';
import { OrderStatusSchema } from '@compass/contracts/schemas/order';
import { RunStatusSchema } from '@compass/contracts/schemas/run';
import { createI18n, loadCatalog } from '@compass/i18n';
import {
  confirmStatusLabel,
  deliveryStageLabel,
  orderStatusLabel,
  runStatusLabel,
  runStepLabel,
  subscriptionStatusLabel,
} from '../statusLabels';

beforeAll(async () => {
  await Promise.all([loadCatalog('en'), loadCatalog('ru')]);
});

describe('status labels (UI-2)', () => {
  test('every value of every status has a word of its own', () => {
    const en = createI18n('en');
    const unknown = en.t('common.unknownStatus');
    const tables: [readonly string[], (status: string) => string][] = [
      [OrderStatusSchema.options, (s) => orderStatusLabel(en, s)],
      [RunStatusSchema.options, (s) => runStatusLabel(en, s)],
      [RunStatusSchema.options, (s) => runStepLabel(en, s)],
      [ConfirmStatusSchema.options, (s) => confirmStatusLabel(en, s)],
      [SubscriptionStatusSchema.options, (s) => subscriptionStatusLabel(en, s)],
    ];
    for (const [values, label] of tables) {
      const words = values.map(label);
      expect(words).not.toContain(unknown);
      expect(new Set(words).size).toBe(values.length);
    }
  });

  test('a status this build does not know, or none, reads as unknown', () => {
    const en = createI18n('en');
    expect(orderStatusLabel(en, 'paused')).toBe('Unknown status');
    expect(runStatusLabel(en, null)).toBe('Unknown status');
    expect(confirmStatusLabel(en, undefined)).toBe('Unknown status');
    // A name every object has is not a status.
    expect(runStepLabel(en, 'constructor')).toBe('Unknown status');
  });

  test('a rejected order reads "Rejected" alone, with no slot for a reason (ORD-18)', () => {
    expect(orderStatusLabel(createI18n('en'), 'rejected')).toBe('Rejected');
  });

  test('a cancelled run names its step, not the raw value (RUNWEB1-26)', () => {
    const ru = createI18n('ru');
    expect(runStepLabel(createI18n('en'), 'cancelled')).toBe('Cancelled');
    expect(runStepLabel(ru, 'planned')).toBe(ru.t('run.step.plan'));
  });

  test("a store's delivery stage", () => {
    const en = createI18n('en');
    expect(deliveryStageLabel(en, 'pending')).toBe(en.t('run.deliveryStage.pending'));
    expect(deliveryStageLabel(en, 'confirmed')).toBe(en.t('run.deliveryStage.confirmed'));
  });
});
