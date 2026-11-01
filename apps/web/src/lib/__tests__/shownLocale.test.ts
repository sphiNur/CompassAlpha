import { beforeEach, describe, expect, test } from 'bun:test';
import type { Locale } from '@compass/i18n';
import { resetShownLocale, shownLocaleFor } from '../shownLocale';

const loadedSet = (...locales: Locale[]) => (l: Locale) => locales.includes(l);

describe('shownLocaleFor (DX-PFE-2: no catalog is bundled)', () => {
  beforeEach(() => resetShownLocale());

  test('the wanted language once its catalog is in', () => {
    expect(shownLocaleFor('zh', loadedSet('zh'))).toBe('zh');
  });

  test('keeps the language on screen while a new one loads', () => {
    expect(shownLocaleFor('zh', loadedSet('zh'))).toBe('zh');
    // Switched to Russian in Settings; ru.ts still downloading.
    expect(shownLocaleFor('ru', loadedSet('zh'))).toBe('zh');
    expect(shownLocaleFor('ru', loadedSet('zh', 'ru'))).toBe('ru');
  });

  test('falls back to whatever loaded — English when the wanted one failed offline', () => {
    expect(shownLocaleFor('uz', loadedSet('en'))).toBe('en');
  });

  test('nothing loaded yet: the wanted language (I18nGate hides that render)', () => {
    expect(shownLocaleFor('ru', loadedSet())).toBe('ru');
  });
});
