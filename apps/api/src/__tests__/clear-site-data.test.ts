import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { callsSignOut, clearSiteDataOnSignOut } from '../http/clearSiteData';

describe('Clear-Site-Data on sign-out (review MWD-20)', () => {
  test('callsSignOut finds the procedure alone or in a batch', () => {
    expect(callsSignOut('/trpc/auth.signOut')).toBe(true);
    expect(callsSignOut('/trpc/me.get,auth.signOut')).toBe(true);
    expect(callsSignOut('/trpc/auth.signOutX')).toBe(false);
    expect(callsSignOut('/trpc/me.get')).toBe(false);
    expect(callsSignOut('/auth.signOut')).toBe(false);
  });

  function app(status: number) {
    const a = new Hono();
    a.use('/trpc/*', clearSiteDataOnSignOut());
    a.all('/trpc/*', () => new Response('{}', { status }));
    return a;
  }

  test('a successful sign-out clears the cache only', async () => {
    const res = await app(200).request('/trpc/auth.signOut?batch=1', { method: 'POST' });
    expect(res.headers.get('Clear-Site-Data')).toBe('"cache"');
  });

  test('a failed sign-out, a GET or another call sends nothing', async () => {
    const failed = await app(401).request('/trpc/auth.signOut', { method: 'POST' });
    expect(failed.headers.get('Clear-Site-Data')).toBeNull();
    const get = await app(200).request('/trpc/auth.signOut');
    expect(get.headers.get('Clear-Site-Data')).toBeNull();
    const other = await app(200).request('/trpc/me.get', { method: 'POST' });
    expect(other.headers.get('Clear-Site-Data')).toBeNull();
  });
});
