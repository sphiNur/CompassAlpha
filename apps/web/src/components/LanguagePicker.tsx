/**
 * The language choices of the settings sheet and the language sheet.
 *
 * Review COREWEB1-21 (2026-11-12): the language list, the selected check
 * and the save were written out in both sheets, and differed: one closed
 * after a pick and the other did not. Each language is named in itself
 * with no hint: the "EN" or "ZH" beside "English" or "中文" told nothing
 * more (UI-10).
 *
 * Both save at once and return the fresh session; the auth store takes it,
 * and every page re-renders in the new language, product names included.
 * The four languages are the four NamesSchema asks of products and
 * categories.
 */
import { LANGUAGE_NATIVE_NAMES, type Locale } from '@compass/i18n';
import { PickerGroup, PickerRow } from '@compass/ui';
import { useErrToast } from '../hooks/useErrToast';
import { useI18n } from '../hooks/useI18n';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';

/** The order the pickers list languages in. */
const PICKER_ORDER: readonly Locale[] = ['uz', 'ru', 'en', 'zh'];

/**
 * The interface language. The Telegram language only guesses it: a
 * Russian-speaking cashier in an Uzbek restaurant may keep Telegram in
 * Russian and want the app in Uzbek, as the shelf labels read.
 */
export function LanguagePicker({
  onPicked,
}: {
  /** After a language is saved, or the current one is tapped again. */
  onPicked?: () => void;
}) {
  const i18n = useI18n();
  const current = useAuthStore((s) => s.session?.user.locale ?? 'en');
  const patchSession = useAuthStore((s) => s.patchSession);
  const errToast = useErrToast();
  const setLocale = trpc.auth.setLocale.useMutation({
    onSuccess: (next) => {
      patchSession(next);
      onPicked?.();
    },
    onError: errToast('common.errors.actionFailed'),
  });
  return (
    <PickerGroup label={i18n.t('settings.language.title')}>
      {PICKER_ORDER.map((code) => {
        const selected = current === code;
        return (
          <PickerRow
            key={code}
            label={LANGUAGE_NATIVE_NAMES[code]}
            lang={code}
            selected={selected}
            disabled={setLocale.isPending}
            onClick={() => {
              if (selected) onPicked?.();
              else setLocale.mutate({ locale: code });
            }}
          />
        );
      })}
    </PickerGroup>
  );
}

/**
 * M3.45 (2026-05-22): a second language for product names, shown under
 * each name (UI-4), and the one the purchase lists copied for suppliers
 * are written in: a Chinese-speaking purchaser sends an Uzbek supplier a
 * list in Uzbek. "Off" comes first, a choice of its own rather than a
 * clear button.
 */
export function SecondaryLanguagePicker() {
  const i18n = useI18n();
  const locale = useAuthStore((s) => s.session?.user.locale ?? 'en');
  const current = useAuthStore((s) => s.session?.user.secondaryLocale ?? null);
  const patchSession = useAuthStore((s) => s.patchSession);
  const errToast = useErrToast();
  const setSecondaryLocale = trpc.auth.setSecondaryLocale.useMutation({
    onSuccess: (next) => {
      patchSession(next);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const choose = (next: Locale | null) => {
    if (next !== current) setSecondaryLocale.mutate({ secondaryLocale: next });
  };
  return (
    <PickerGroup label={i18n.t('settings.secondaryLanguage.title')}>
      <PickerRow
        label={i18n.t('settings.secondaryLanguage.off')}
        hint={i18n.t('settings.secondaryLanguage.offHint')}
        selected={current === null}
        disabled={setSecondaryLocale.isPending}
        onClick={() => choose(null)}
      />
      {PICKER_ORDER.filter((code) => code !== locale).map((code) => (
        <PickerRow
          key={code}
          label={LANGUAGE_NATIVE_NAMES[code]}
          lang={code}
          selected={current === code}
          disabled={setSecondaryLocale.isPending}
          onClick={() => choose(code)}
        />
      ))}
    </PickerGroup>
  );
}
