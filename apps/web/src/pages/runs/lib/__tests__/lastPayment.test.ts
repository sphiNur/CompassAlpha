import { afterEach, describe, expect, it } from 'bun:test';
import { memoryStorage, throwingStorage } from '../../../../__tests__/helpers/storage';
import { lastPaymentMethod, rememberPaymentMethod } from '../lastPayment';

const g = globalThis as { window?: unknown };
const realWindow = g.window;

afterEach(() => {
  g.window = realWindow;
});

describe('the run’s last payment method (R10)', () => {
  it('is cash until one is chosen', () => {
    g.window = { localStorage: memoryStorage() };
    expect(lastPaymentMethod('run-1')).toBe('cash');
  });

  it('is the one last chosen in this run', () => {
    g.window = { localStorage: memoryStorage() };
    rememberPaymentMethod('run-1', 'transfer');
    expect(lastPaymentMethod('run-1')).toBe('transfer');
    rememberPaymentMethod('run-1', 'cash');
    expect(lastPaymentMethod('run-1')).toBe('cash');
  });

  it('does not carry over to another run', () => {
    g.window = { localStorage: memoryStorage() };
    rememberPaymentMethod('run-1', 'transfer');
    expect(lastPaymentMethod('run-2')).toBe('cash');
  });

  it('is cash where storage is blocked', () => {
    g.window = { localStorage: throwingStorage() };
    rememberPaymentMethod('run-1', 'transfer');
    expect(lastPaymentMethod('run-1')).toBe('cash');
  });
});
