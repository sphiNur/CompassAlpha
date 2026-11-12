import { describe, expect, test } from 'bun:test';
import { readWorkerConfig } from './config';

const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5433/compass_test' };

describe('readWorkerConfig (COREAPI-27)', () => {
  test('the defaults when nothing optional is set', () => {
    expect(readWorkerConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      relayUrl: null,
      relayKey: null,
      botToken: null,
      botDeliveryEnabled: null,
      frontendUrl: null,
      claimTimeoutMinutes: 30,
      claimTimeoutScanMinutes: 5,
    });
  });

  test('reads what is set; blank counts as unset', () => {
    const config = readWorkerConfig({
      ...BASE,
      TG_RELAY_URL: 'https://relay.example',
      COMPASS_RELAY_KEY: 'k'.repeat(32),
      BOT_DELIVERY_ENABLED: 'TRUE',
      FRONTEND_URL: 'https://app.example',
      CLAIM_TIMEOUT_MINUTES: '0',
      CLAIM_TIMEOUT_SCAN_MINUTES: ' 10 ',
      TELEGRAM_BOT_TOKEN: '',
    });
    expect(config).toMatchObject({
      relayUrl: 'https://relay.example',
      botDeliveryEnabled: true,
      frontendUrl: 'https://app.example',
      claimTimeoutMinutes: 0,
      claimTimeoutScanMinutes: 10,
      botToken: null,
    });
  });

  test('a value that is set but wrong stops the start, naming every one', () => {
    // CLAIM_TIMEOUT_MINUTES=3O used to read as NaN and turn the release off.
    expect(() => readWorkerConfig({ ...BASE, CLAIM_TIMEOUT_MINUTES: '3O' })).toThrow(
      'CLAIM_TIMEOUT_MINUTES must be a whole number of minutes, at least 0',
    );
    let message = '';
    try {
      readWorkerConfig({
        CLAIM_TIMEOUT_SCAN_MINUTES: '0',
        BOT_DELIVERY_ENABLED: 'yes',
        FRONTEND_URL: 'app.example',
        CLAIM_TIMEOUT_MINUTES: '-5',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('DATABASE_URL is required');
    expect(message).toContain('BOT_DELIVERY_ENABLED must be true or false');
    expect(message).toContain('FRONTEND_URL is not a URL');
    expect(message).toContain('CLAIM_TIMEOUT_MINUTES must be');
    expect(message).toContain(
      'CLAIM_TIMEOUT_SCAN_MINUTES must be a whole number of minutes, at least 1',
    );
  });
});
