/**
 * The refresh endpoint must accept the tokens the server issues.
 *
 * It did not: RefreshInputSchema capped the token at 200 characters and
 * a signed refresh token is 296, so every refresh was rejected with 400
 * before reaching the handler. Nothing exercised the two together.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RefreshInputSchema } from '@compass/contracts';
import { signRefresh } from '../infra/jwt';

describe('refresh token contract', () => {
  test('a token signed by the server passes the refresh input schema', async () => {
    const token = await signRefresh(randomUUID(), randomUUID(), randomUUID());
    const parsed = RefreshInputSchema.safeParse({ refreshToken: token });
    expect(parsed.success).toBe(true);
  });

  test('the schema still turns away junk', () => {
    expect(RefreshInputSchema.safeParse({ refreshToken: 'short' }).success).toBe(false);
    expect(RefreshInputSchema.safeParse({ refreshToken: 'x'.repeat(5000) }).success).toBe(false);
  });
});
