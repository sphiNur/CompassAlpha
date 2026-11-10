/**
 * UI-08: the copy @compass/ui renders by itself comes from the catalog.
 * ConfirmSheet's Cancel and Reason, and SearchInput's "Clear search",
 * were English in every language: zh, ru and uz users saw "Cancel" on
 * the confirm for withdrawing face-data consent.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createI18n, loadCatalog, type Locale } from '@compass/i18n';
import { DEFAULT_UI_LABELS } from '@compass/ui';
import { uiLabelsFor } from '../uiLabels';

const LOCALES: Locale[] = ['en', 'zh', 'ru', 'uz'];

beforeAll(async () => {
  await Promise.all(LOCALES.map((locale) => loadCatalog(locale)));
});

describe("the design system's own copy", () => {
  test('the app gives every label the design system has', () => {
    const labels = uiLabelsFor(createI18n('zh'));
    const missing = Object.keys(DEFAULT_UI_LABELS).filter((key) => !(key in labels));
    expect(missing).toEqual([]);
  });

  test('Cancel, Reason and Clear search follow the interface language', () => {
    const said = LOCALES.map((locale) => {
      const labels = uiLabelsFor(createI18n(locale));
      return [locale, labels.cancel, labels.reason, labels.clearSearch];
    });
    expect(said).toEqual([
      ['en', 'Cancel', 'Reason', 'Clear search'],
      ['zh', '取消', '原因', '清除搜索'],
      ['ru', 'Отмена', 'Причина', 'Сбросить поиск'],
      ['uz', 'Bekor qilish', 'Sabab', 'Qidiruvni tozalash'],
    ]);
  });
});
