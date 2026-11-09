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
