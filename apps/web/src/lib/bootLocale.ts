import { detectLocale, type Locale } from '@compass/i18n';

/**
 * DX-PFE-1 (2026-11-01): the language the first screen is drawn in. A
 * signed-in person's own choice (the persisted session's `user.locale`)
 * wins over Telegram's / the browser's language; before this, a zh user
 * whose Telegram is English saw a full English screen until the zh
 * catalog arrived.
 */
export function bootLocale(
  storage: Pick<Storage, 'getItem'> | null,
  platformLanguage: string,
): Locale {
  try {
    const raw = storage?.getItem('compass.auth');
    if (raw) {
      const chosen = (JSON.parse(raw) as { state?: { session?: { user?: { locale?: unknown } } } })
        .state?.session?.user?.locale;
      if (typeof chosen === 'string' && chosen) return detectLocale(chosen);
    }
  } catch {
    /* unparseable or storage blocked: the platform's language */
  }
  return detectLocale(platformLanguage);
}

/**
 * Resolves when `load` settles or after `ms`, whichever comes first, so a
 * slow or failing catalog download never keeps the app from starting (it
 * then starts in English and switches when the catalog lands, as before).
 */
export function waitAtMost(load: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    load.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
