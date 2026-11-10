/**
 * The app's catalog strings for @compass/ui's own copy (UiLabels). Kept
 * apart from UiLabelsBridge so a test can check that every label the
 * design system renders has a translation here.
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
import type { I18n } from '@compass/i18n';
import type { UiLabels } from '@compass/ui';
import { errorTextKey, errorTextOf } from '../lib/errorText';
import { confirmNative } from '../lib/confirm';

export function uiLabelsFor(i18n: I18n): UiLabels {
  return {
    get decrement() {
      return i18n.t('qty.decrement');
    },
    get increment() {
      return i18n.t('qty.increment');
    },
    quantityPick: (valueWithUnit) => i18n.t('qty.pickAria', { value: valueWithUnit }),
    quantityOf: (item) => i18n.t('qty.groupAria', { item }),
    get setQuantity() {
      return i18n.t('qty.setTitle');
    },
    unitIs: (unit) => i18n.t('qty.unitIs', { unit }),
    get custom() {
      return i18n.t('qty.custom');
    },
    setValue: (valueWithUnit) => i18n.t('qty.setValue', { value: valueWithUnit }),
    get qtyEnterNumber() {
      return i18n.t('qty.enterNumber');
    },
    qtyAtLeast: (min) => i18n.t('qty.atLeast', { min }),
    qtyAtMost: (max) => i18n.t('qty.atMost', { max }),
    qtyMaxDecimals: (decimals) => i18n.t('qty.maxDecimals', { decimals }),
    qtyNotMultiple: (step) => i18n.t('qty.notMultiple', { step }),
    get numberInvalid() {
      return i18n.t('number.invalid');
    },
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
    get offlineNoData() {
      return i18n.t('common.offlineNoData');
    },
    // 2026-10-21 FE-10: DataState showed `error.message` raw — usually an
    // untranslated server key. Same mapping as errToast's toasts.
    // CMP-FE-1: with the placeholders a server error carries.
    translateError: (message, error) => {
      const said =
        error === undefined
          ? { key: errorTextKey(message, 'common.errorUnknown'), vars: {} }
          : errorTextOf(error, 'common.errorUnknown');
      return i18n.t(said.key as Parameters<typeof i18n.t>[0], said.vars);
    },
    get retry() {
      return i18n.t('common.retry');
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
    get photoUploadFailed() {
      return i18n.t('photo.uploadFailed');
    },
    // CMP-INV-2: a sheet with unsaved input asks before it closes, with
    // Telegram's own confirm inside Telegram.
    get discardChanges() {
      return i18n.t('catalog.confirm.discardEdits');
    },
    confirmDiscard: (message) => confirmNative(message),
    // UI-08: these were English in every language.
    get cancel() {
      return i18n.t('common.cancel');
    },
    get reason() {
      return i18n.t('common.reason');
    },
    get clearSearch() {
      return i18n.t('common.clearSearch');
    },
  };
}
