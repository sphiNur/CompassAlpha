/**
 * Review OPS-14 (2026-11): the built web app's files, index.html for any
 * other page, and a 404 for a hashed file that is not there. That used to
 * be index.html too, which the edge Worker could keep in place of the
 * face tracker for good.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { NOT_FOUND_BODY } from '../http/errorBodies';
import { serveWebApp } from '../http/webApp';

const INDEX = '<!doctype html><title>Compass</title>';
const dist = mkdtempSync(join(tmpdir(), 'web-dist-'));
afterAll(() => rmSync(dist, { recursive: true, force: true }));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), INDEX);
writeFileSync(join(dist, 'assets', 'index-1.js'), 'console.log(1)');
writeFileSync(join(dist, 'build-id.txt'), 'abc');

const app = new Hono();
serveWebApp(app, dist);
app.notFound((c) => c.json(NOT_FOUND_BODY, 404));
const get = (path: string) => app.request(path);

describe('the web app (OPS-14)', () => {
  test('its files, as they are', async () => {
    const js = await get('/assets/index-1.js');
    expect([js.status, await js.text()]).toEqual([200, 'console.log(1)']);
    expect(await (await get('/build-id.txt')).text()).toBe('abc');
  });

  // Run from the repository root with the app in the temp directory, as
  // the api runs from apps/api: the fallback must not depend on the cwd.
  test('index.html for any page, so the router takes over', async () => {
    for (const path of ['/', '/order', '/admin/members']) {
      const res = await get(path);
      expect([res.status, await res.text()]).toEqual([200, INDEX]);
    }
  });

  test('a hashed file that is not there is a 404, never the page', async () => {
    for (const path of [
      '/assets/vision-2.wasm',
      '/assets/face_landmarker-2.task',
      '/assets/index-2.js',
    ]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'NOT_FOUND', i18nKey: 'common.errors.notFound' });
    }
  });
});
