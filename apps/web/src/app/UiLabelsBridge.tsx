/**
 * Bridges the app's i18n catalog into @compass/ui's label context
 * (2026-07-30).
 *
 * `@compass/ui` renders a handful of strings itself — QtyControl's
 * aria-labels and its whole quick-pick sheet, DataState's loading/empty/
 * error states, PhotoCapture's hints. The package has no i18n dependency
 * on purpose (host-agnostic design system), so those strings were frozen
 * English on every screen of an app that ships zh/ru/uz. The worst of them
 * was the quick-pick sheet: "Set quantity" / "Unit: kg" / "Custom" /
 * "Set 3 kg" — the fast path for entering a quantity, i.e. the app's
 * single most-used interaction.
 *
 * WHY EVERY FIELD IS A GETTER
 *
 * Catalogs load lazily (`useEnsureLocale` fires a dynamic import and bumps
 * a module-level counter when it resolves). `useI18n()` returns
 * `useMemo(() => createI18n(resolved), [resolved])`, so the i18n object is
 * referentially STABLE across that load — which means a memo keyed on it
 * never recomputes once the catalog lands.
 *
 * The first version of this file resolved each string eagerly inside such
 * a memo. Result: the labels were computed during the one frame before the
 * zh catalog resolved, got the English fallback, and froze there for the
 * session. The function-valued fields (`quantityPick`, `unitIs`) looked
 * fine, purely because they call `i18n.t` at INVOCATION time, by which
 * point the catalog had loaded — which is what made the bug so confusing
 * on screen: "单位: 公斤" right above a stubbornly English "CUSTOM".
 *
 * Getters give every field the late-binding the function fields had by
 * accident. `labels.custom` still reads as a plain string at the call
 * site; the lookup just happens on access instead of on mount.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { UiLabelsProvider } from '@compass/ui';
import type { UiLabels } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';

export function UiLabelsBridge({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  // Memoized on the i18n instance so the provider's merged object stays
  // referentially stable between renders — otherwise every primitive
  // reading the context re-renders on each pass. Safe to memo BECAUSE the
  // fields are getters: staleness of the object identity no longer implies
  // staleness of the strings.
  const labels = useMemo<Partial<UiLabels>>(
    () => ({
      get decrement() {
        return i18n.t('qty.decrement');
      },
      get increment() {
        return i18n.t('qty.increment');
      },
      quantityPick: (valueWithUnit) => i18n.t('qty.pickAria', { value: valueWithUnit }),
      get setQuantity() {
        return i18n.t('qty.setTitle');
      },
      unitIs: (unit) => i18n.t('qty.unitIs', { unit }),
      get custom() {
        return i18n.t('qty.custom');
      },
      setValue: (valueWithUnit) => i18n.t('qty.setValue', { value: valueWithUnit }),
      get errorTitle() {
        return i18n.t('common.error');
      },
      get errorUnknown() {
        return i18n.t('common.errorUnknown');
      },
      get emptyNoData() {
        return i18n.t('common.noData');
      },
      get emptyNothingYet() {
        return i18n.t('common.empty');
      },
      get photoLabel() {
        return i18n.t('photo.label');
      },
      get photoRemove() {
        return i18n.t('photo.remove');
      },
      get photoHint() {
        return i18n.t('photo.hint');
      },
      get uploading() {
        return i18n.t('photo.uploading');
      },
    }),
    [i18n],
  );
  return <UiLabelsProvider labels={labels}>{children}</UiLabelsProvider>;
}
