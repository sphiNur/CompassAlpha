/**
 * DX-PFE-2 (2026-11-01): no catalog is bundled into the web's startup
 * chunk, English included. These guard the two halves of that: the
 * registry imports en only as a type, and English is still there as
 * the fallback once loaded.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureCatalog, isCatalogKey, isLoaded, loadCatalog, lookup } from '../index';
import type { CatalogKey, Locale } from '../index';

describe('catalog registry', () => {
  test('imports no catalog statically (each locale is its own chunk)', () => {
    // Review TEST4-16: what a bundler sees (type-only imports dropped,
    // `export … from` and require included), not a regex over the source.
    const src = readFileSync(join(import.meta.dir, '../catalogs/index.ts'), 'utf8');
    const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(src);
    const catalogs = imports.filter((i) => /^\.\/(en|zh|ru|uz)$/.test(i.path));
    expect(catalogs.filter((i) => i.kind !== 'dynamic-import')).toEqual([]);
    expect(catalogs.map((i) => i.path).sort()).toEqual(['./en', './ru', './uz', './zh']);
  });

  test('ensureCatalog resolves to the locale it loaded', async () => {
    expect(await ensureCatalog('zh')).toBe('zh');
    expect(isLoaded('zh')).toBe(true);
    expect(await ensureCatalog('en')).toBe('en');
  });

  test('lookups fall back to English once it is loaded', async () => {
    await loadCatalog('en');
    expect(lookup('common.retry' as CatalogKey, 'en')).toBe('Retry');
    // A key every catalog has reads in the requested language, not English.
    await loadCatalog('zh');
    expect(lookup('common.retry' as CatalogKey, 'zh')).not.toBe('Retry');
  });

  test('isCatalogKey knows the loaded catalogs’ keys and nothing else (COREWEB2-19)', async () => {
    await loadCatalog('en');
    expect(isCatalogKey('common.retry')).toBe(true);
    expect(isCatalogKey('order.errors.fromANewerServer')).toBe(false);
    // Not an inherited property of the catalog object either.
    expect(isCatalogKey('toString')).toBe(false);
  });

  test('a name that is no locale gets English without being filed as loaded (COREWEB2-10)', async () => {
    const raw = 'zh-hans' as Locale;
    const catalog = await loadCatalog(raw);
    expect(catalog['common.retry']).toBe('Retry');
    expect(isLoaded(raw)).toBe(false);
  });
});
