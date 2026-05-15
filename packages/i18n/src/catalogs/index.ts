/**
 * Catalog registry (M3.14-D, 2026-05-16): English is statically
 * imported (it's the bundle's fallback and CatalogKey type source),
 * and the other three locales are loaded on demand via dynamic
 * import.
 *
 * Why: zh.ts / ru.ts / uz.ts are ~30-47 KB each (~120 KB raw, ~30 KB
 * gzip after minification). Most sessions only ever use ONE locale,
 * so static-importing all four wasted the other three. The dynamic
 * loader runs once per locale per session and is cached at the
 * module level.
 *
 * Public surface:
 *   - catalogs.en — synchronous, always available.
 *   - loadCatalog(locale) — Promise that resolves the catalog object;
 *     returns the cached one if already loaded.
 *   - getLoadedCatalog(locale) — synchronous accessor; returns
 *     undefined until loadCatalog has resolved.
 *
 * Consumers (apps/web/src/hooks/useI18n.ts) call loadCatalog on the
 * active locale and force a re-render when it lands. Until then the
 * lookup falls back through en, so the UI is bilingual-degraded
 * (never blank) during the ~1-frame load window.
 */
import { en } from './en';

export type Locale = 'en' | 'zh' | 'ru' | 'uz';

export type CatalogModule = Record<string, string>;

/** All keys that exist in `en`. CI grep-checks every other locale matches. */
export type CatalogKey = keyof typeof en;

// Module-level cache: en is preloaded; others land when loadCatalog
// resolves. The Map is preferred over a plain object to keep typing
// clean against `Locale`.
const loaded = new Map<Locale, CatalogModule>([['en', en]]);

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
  // chunks; only the requested one is fetched at runtime. en is
  // already loaded above so we don't dynamic-import it.
  const promise = (async () => {
    switch (locale) {
      case 'en':
        return en;
      case 'zh':
        return (await import('./zh')).zh as CatalogModule;
      case 'ru':
        return (await import('./ru')).ru as CatalogModule;
      case 'uz':
        return (await import('./uz')).uz as CatalogModule;
      default:
        return en;
    }
  })();
  inFlight.set(locale, promise);
  const mod = await promise;
  loaded.set(locale, mod);
  inFlight.delete(locale);
  return mod;
}

/**
 * Eagerly preload a locale without awaiting. Fire-and-forget — used
 * by the auth gate so the user's locale starts loading the moment
 * we know it, even before any t() call runs.
 */
export function preloadCatalog(locale: Locale): void {
  void loadCatalog(locale);
}

/** Compatibility shim for the old static `catalogs` shape. New code
 *  should use getLoadedCatalog(locale) directly. */
export const catalogs = {
  get en() {
    return en;
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
