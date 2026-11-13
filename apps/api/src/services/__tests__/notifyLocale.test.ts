/**
 * Notifications in the recipient's language (APR-16 / DLV-5, 2026-10-31).
 * Titles and bodies were English for everyone, without the store's name.
 */
import { describe, expect, test } from 'bun:test';
import { detectLocale, lookup } from '@compass/i18n';
import { localizeEnvelope, openAppLabel } from '../notify';

describe('localizeEnvelope', () => {
  test('a known template is rendered from the catalog with its values', async () => {
    const delivered = {
      template: 'run.storeDelivered',
      title: 'Delivery arrived',
      body: 'Items have been delivered to your store — please confirm.',
      vars: { store: 'Central Kitchen' },
    };
    const zh = await localizeEnvelope(delivered, 'zh');
    // Checked against the catalog, not its wording (review TEST4-20,
    // 2026-11): rewording the line keeps this green; the wrong language or
    // a dropped value does not.
    expect(zh.title).toBe(lookup('notify.run.storeDelivered.title', 'zh')!);
    expect(zh.body).toContain('Central Kitchen');
    expect(zh.body).not.toBe((await localizeEnvelope(delivered, 'en')).body);
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
    expect(out).toEqual({
      title: lookup('notify.order.rejected.title', 'uz')!,
      body: 'Нет молока',
    });
  });

  test('a template the catalog does not know keeps the English envelope', async () => {
    const out = await localizeEnvelope({ template: 'run.someday', title: 'T', body: 'B' }, 'ru');
    expect(out).toEqual({ title: 'T', body: 'B' });
  });

  test('a language there is no catalog for gets English', async () => {
    // A recipient's setting reaches here through detectLocale.
    const out = await localizeEnvelope(
      { template: 'order.rejected', title: 'x', body: 'y' },
      detectLocale('de-DE'),
    );
    expect(out).toEqual({
      title: lookup('notify.order.rejected.title', 'en')!,
      body: lookup('notify.order.rejected.body', 'en'),
    });
  });

  test('a value the template needs and the envelope lacks fails a test run', async () => {
    // A user would see a gap where it goes (packages/i18n format); in a
    // test the emitter that forgot it fails.
    await expect(
      localizeEnvelope({ template: 'run.storeDelivered', title: 'x', body: 'y', vars: {} }, 'en'),
    ).rejects.toThrow('needs {store}');
  });
});

describe('openAppLabel (COREAPI-19)', () => {
  test("the button under a bot message is in the recipient's language", async () => {
    expect(await openAppLabel('en')).toBe('Open Compass');
    expect(await openAppLabel('zh')).toBe('打开 Compass');
    expect(await openAppLabel('ru')).toBe('Открыть Compass');
    expect(await openAppLabel('uz')).toBe('Compassʼni ochish');
  });
});
