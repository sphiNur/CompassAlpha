/**
 * Notifications in the recipient's language (APR-16 / DLV-5, 2026-10-31).
 * Titles and bodies were English for everyone, without the store's name.
 */
import { describe, expect, test } from 'bun:test';
import { localizeEnvelope } from '../notify';

describe('localizeEnvelope', () => {
  test('a known template is rendered from the catalog with its values', async () => {
    const zh = await localizeEnvelope(
      {
        template: 'run.storeDelivered',
        title: 'Delivery arrived',
        body: 'Items have been delivered to your store — please confirm.',
        vars: { store: 'Central Kitchen' },
      },
      'zh',
    );
    expect(zh).toEqual({ title: '货已送到', body: '货已送到 Central Kitchen，请确认收货。' });
    const ru = await localizeEnvelope(
      { template: 'run.storeConfirmedWithIssues', title: 'x', body: 'y', vars: { store: 'CK', n: 21 } },
      'ru',
    );
    expect(ru.body).toContain('21 позиция');
  });

  test('a typed reason is kept as the body', async () => {
    const out = await localizeEnvelope(
      { template: 'order.rejected', title: 'Order rejected', body: 'fallback', reason: 'Нет молока' },
      'uz',
    );
    expect(out).toEqual({ title: 'Buyurtma rad etildi', body: 'Нет молока' });
  });

  test('a template the catalog does not know keeps the English envelope', async () => {
    const out = await localizeEnvelope({ template: 'run.someday', title: 'T', body: 'B' }, 'ru');
    expect(out).toEqual({ title: 'T', body: 'B' });
  });
});
