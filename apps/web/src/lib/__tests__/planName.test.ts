import { beforeAll, describe, expect, test } from 'bun:test';
import { loadCatalog } from '@compass/i18n';
import { planName } from '../planName';

describe('planName (review WALK-05)', () => {
  beforeAll(async () => {
    await Promise.all([loadCatalog('en'), loadCatalog('zh'), loadCatalog('uz')]);
  });

  test("a built-in plan is named in the reader's language", () => {
    expect(planName('legacy', 'Legacy / Enterprise', 'zh')).toBe('企业版（早期协议）');
    expect(planName('starter', 'Starter', 'uz')).toBe('Boshlangʻich');
    expect(planName('pro', 'Professional', 'en')).toBe('Professional');
  });

  test('a plan the catalogs do not know keeps its stored name', () => {
    expect(planName('custom-2027', 'Custom deal', 'zh')).toBe('Custom deal');
  });
});
