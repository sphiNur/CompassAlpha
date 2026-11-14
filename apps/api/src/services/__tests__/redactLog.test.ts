/**
 * Review MWD-15 (modern-web-guidance: privacy): what `system.log` masks
 * before a client log line is stored or mirrored to the journal.
 */
import { describe, expect, test } from 'bun:test';
import { redactLogText, redactLogValue } from '../redactLog';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('redactLogText', () => {
  test('bearer tokens and JWTs', () => {
    expect(redactLogText('Authorization: Bearer abc.def-ghi_jkl123')).toBe(
      'Authorization: Bearer [token]',
    );
    expect(redactLogText(`refresh failed for ${JWT} at x`)).toBe('refresh failed for [jwt] at x');
    // A cut-off one (the field was sliced to its limit) still goes.
    expect(redactLogText(`t=${JWT.slice(0, 60)}`)).not.toContain('eyJzdWIi');
  });

  test('Telegram launch data in a fragment and in init data', () => {
    const url =
      'https://app.example/#tgWebAppData=query_id%3DAAH%26user%3D%257B%2522id%2522%253A1%257D%26hash%3Dabc&tgWebAppVersion=8.0';
    expect(redactLogText(`load failed: ${url} end`)).toBe(
      'load failed: https://app.example/#[telegram] end',
    );
    const init =
      'query_id=AAHdF6IQ&user=%7B%22id%22%3A279058397%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2';
    const out = redactLogText(`bad initData: ${init}`);
    expect(out).toBe(
      'bad initData: query_id=[redacted]&user=[redacted]&auth_date=1662771648&hash=[redacted]',
    );
    expect(redactLogText('?tgWebAppData=abc&x=1')).toBe('?tgWebAppData=[redacted]&x=1');
    expect(redactLogText('/auth?access_token=xyz&ok=1')).toBe('/auth?access_token=[redacted]&ok=1');
  });

  test('e-mail addresses', () => {
    expect(redactLogText('no account for ali.v+test@mail.example.uz, retry')).toBe(
      'no account for [email], retry',
    );
  });

  test('phone numbers in the usual shapes', () => {
    expect(redactLogText('call +998 90 123-45-67 now')).toBe('call [phone] now');
    expect(redactLogText('phone 13812345678')).toBe('phone [phone]');
    expect(redactLogText('(90) 123 45 67')).toBe('[phone]');
    expect(redactLogText('+79161234567')).toBe('[phone]');
    expect(redactLogText('tel 901234567')).toBe('tel [phone]');
  });

  test('stacks, ids, versions and timestamps stay', () => {
    const stack = 'at onClick (https://app.example/assets/index-4f3a2b1c.js:2:123456)';
    expect(redactLogText(stack)).toBe(stack);
    const uuid = 'run 550e8400-e29b-41d4-a716-446655440000 missing';
    expect(redactLogText(uuid)).toBe(uuid);
    expect(redactLogText('at 1731600000000 / 1731600000 v1.2.3 code 500')).toBe(
      'at 1731600000000 / 1731600000 v1.2.3 code 500',
    );
    expect(redactLogText('react-dom@18.3.1')).toBe('react-dom@18.3.1');
    expect(redactLogText('due 2026-11-14 12:30:00')).toBe('due 2026-11-14 12:30:00');
    expect(redactLogText('')).toBe('');
  });
});

describe('redactLogValue', () => {
  test('masks every string inside, keeps keys and other values', () => {
    const data = {
      email: 'a@b.example',
      count: 3,
      nested: { list: ['Bearer abcdefgh1234', 7, null], ok: true },
    };
    expect(redactLogValue(data)).toEqual({
      email: '[email]',
      count: 3,
      nested: { list: ['Bearer [token]', 7, null], ok: true },
    });
    expect(redactLogValue(null)).toBeNull();
  });
});
