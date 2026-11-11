import { describe, expect, it } from 'bun:test';
import { zoneName } from '../dateFormat';

describe('zoneName (CONF-18)', () => {
  it('names a zone in the UI language', () => {
    expect(zoneName('Asia/Tashkent', 'en')).toBe('Uzbekistan Standard Time');
    expect(zoneName('Asia/Tashkent', 'zh')).toBe('乌兹别克斯坦标准时间');
    expect(zoneName('Asia/Tashkent', 'ru')).toContain('Узбекистан');
  });

  it('writes Uzbek with the app’s ʻ, not CLDR’s ‘', () => {
    const name = zoneName('Asia/Tashkent', 'uz');
    expect(name).toContain('Oʻzbekiston');
    expect(name).not.toContain('‘');
  });

  it('falls back to the IANA id for a zone it cannot name', () => {
    expect(zoneName('Mars/Olympus', 'en')).toBe('Mars/Olympus');
  });
});
