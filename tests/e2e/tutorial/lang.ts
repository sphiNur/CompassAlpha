import type { Locale } from '@compass/i18n';
import { LOCALES } from './demo';

/** The interface language of this run (TUTORIAL_LANG, default en). */
export function tutorialLang(): Locale {
  const lang = (process.env.TUTORIAL_LANG ?? 'en') as Locale;
  if (!LOCALES.includes(lang)) {
    throw new Error(`TUTORIAL_LANG is one of ${LOCALES.join(', ')}, not "${lang}"`);
  }
  return lang;
}
