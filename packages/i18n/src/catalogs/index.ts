/**
 * Catalog registry (M3.14-D, 2026-05-16): every locale, English included,
 * is loaded on demand via dynamic import.
 *
 * Why: zh.ts / ru.ts / uz.ts are ~30-47 KB each (~120 KB raw, ~30 KB
 * gzip after minification). Most sessions only ever use ONE locale,
 * so static-importing all four wasted the other three. The dynamic
 * loader runs once per locale per session and is cached at the
 * module level.
 *
 * DX-PFE-2 (2026-11-01): en used to be the one static import — the
 * fallback and the CatalogKey type source — which put ~40 KB gzip of
 * English into the startup chunk of every zh / ru / uz user, who never
 * read it (catalog-lint keeps the four catalogs' keys identical). Now
 * en is a chunk like the others; only its type is imported statically.
 * The web app draws nothing until the session language's catalog is in
 * (apps/web I18nGate), and `ensureCatalog` falls back to en when that
 * one cannot be fetched. The api loads en next to the reader's locale.
 *
 * Public surface:
 *   - loadCatalog(locale) — Promise that resolves the catalog object;
 *     returns the cached one if already loaded.
 *   - ensureCatalog(locale) — loads it, or en when it fails to load.
 *   - getLoadedCatalog(locale) — synchronous accessor; returns
 *     undefined until loadCatalog has resolved.
 *
 * Lookups walk locale → en → any other loaded catalog, so a key missing
 * from one catalog still reads in a language once en is loaded.
 */
import type { en } from './en';

export type Locale = 'en' | 'zh' | 'ru' | 'uz';

export type CatalogModule = Record<string, string>;

/** All keys that exist in `en`. CI grep-checks every other locale matches. */
export type CatalogKey = keyof typeof en;

// Module-level cache: each catalog lands when loadCatalog resolves. The
// Map is preferred over a plain object to keep typing clean against
// `Locale`.
const loaded = new Map<Locale, CatalogModule>();

// In-flight promises so two concurrent loadCatalog calls don't fetch
// the same chunk twice (e.g. React StrictMode mounts an effect
// twice in dev).
const inFlight = new Map<Locale, Promise<CatalogModule>>();

export function getLoadedCatalog(locale: Locale): CatalogModule | undefined {
  return loaded.get(locale);
}

export function isLoaded(locale: Locale): boolean {
  return loaded.has(locale);
}

export async function loadCatalog(locale: Locale): Promise<CatalogModule> {
  const existing = loaded.get(locale);
  if (existing) return existing;
  const pending = inFlight.get(locale);
  if (pending) return pending;

  // Vite/Webpack-compatible dynamic import. The bundler emits four
  // chunks; only the requested one is fetched at runtime.
  const promise = (async () => {
    switch (locale) {
      case 'en':
        return (await import('./en')).en as CatalogModule;
      case 'zh':
        return (await import('./zh')).zh as CatalogModule;
      case 'ru':
        return (await import('./ru')).ru as CatalogModule;
      case 'uz':
        return (await import('./uz')).uz as CatalogModule;
      default:
        return (await import('./en')).en as CatalogModule;
    }
  })();
  inFlight.set(locale, promise);
  try {
    const mod = await promise;
    loaded.set(locale, mod);
    return mod;
  } finally {
    // Also on failure: a chunk that failed offline is fetched again on
    // the next call instead of handing back the same rejection forever.
    inFlight.delete(locale);
  }
}

/**
 * Load `locale`, or English when that catalog cannot be fetched (offline
 * with a cold cache, a deploy that removed the chunk). Resolves to the
 * locale that is now available, or null when neither could be loaded —
 * lookups then return the raw keys, which is still better than no screen.
 */
export async function ensureCatalog(locale: Locale): Promise<Locale | null> {
  try {
    await loadCatalog(locale);
    return locale;
  } catch {
    if (locale === 'en') return null;
    try {
      await loadCatalog('en');
      return 'en';
    } catch {
      return null;
    }
  }
}

/**
 * Eagerly preload a locale without awaiting. Fire-and-forget — used
 * by the auth gate so the user's locale starts loading the moment
 * we know it, even before any t() call runs.
 */
export function preloadCatalog(locale: Locale): void {
  loadCatalog(locale).catch(() => {
    /* offline or a removed chunk: the caller's own load reports it */
  });
}

/** Compatibility shim for the old static `catalogs` shape. New code
 *  should use getLoadedCatalog(locale) directly. */
export const catalogs = {
  get en() {
    return loaded.get('en');
  },
  get zh() {
    return loaded.get('zh');
  },
  get ru() {
    return loaded.get('ru');
  },
  get uz() {
    return loaded.get('uz');
  },
};
