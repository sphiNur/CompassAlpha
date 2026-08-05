/**
 * Language picker sheet — lets the user pin their preferred display
 * locale, overriding the Telegram-detected one.
 *
 * Why an explicit picker instead of auto-detect:
 *
 *   The Telegram language_code reflects the user's TELEGRAM UI choice,
 *   not necessarily their working language. A Russian-speaking cashier
 *   in an Uzbek restaurant might keep Telegram in ru but want this app
 *   to render Uzbek SKU names because that's how the printed inventory
 *   labels read. A bilingual manager may prefer zh for ops headers but
 *   uz for raw catalog rows. There's no algorithmic right answer —
 *   give the user the toggle and stop guessing.
 *
 * Persisted via `auth.setLocale`, which writes `auth.users.locale` and
 * returns the fresh session payload. The auth store re-hydrates from
 * that, every page re-renders, every SKU/Category name flips locale
 * in place. No reload needed.
 *
 * The 4 locales here are the same 4 that NamesSchema requires for
 * SKUs/categories — keep them in lockstep.
 */
import { Sheet, Button, PickerRow } from '@compass/ui';
import type { Locale } from '@compass/i18n';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { useErrToast } from '../lib/errToast';

interface LangOption {
  code: Locale;
  /** Native-language label so a uz user sees "O'zbekcha" not "Uzbek". */
  label: string;
  /** Two-letter region tag for the small subtitle. */
  region: string;
}

const LANGS: LangOption[] = [
  { code: 'uz', label: "O'zbekcha", region: 'UZ' },
  { code: 'ru', label: 'Русский', region: 'RU' },
  { code: 'en', label: 'English', region: 'EN' },
  { code: 'zh', label: '中文', region: 'ZH' },
];

interface LanguageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LanguageSheet({ open, onOpenChange }: LanguageSheetProps) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const patchSession = useAuthStore((s) => s.patchSession);
  // M1.21: i18n-aware error toast instead of dumping raw server keys.
  const errToast = useErrToast();

  const setLocale = trpc.auth.setLocale.useMutation({
    onSuccess: (next) => {
      // Server returned the fresh session payload — patch it into the
      // auth store (tokens stay valid). Every page re-renders with the
      // new locale immediately, no reload needed.
      patchSession(next as never);
      onOpenChange(false);
    },
    onError: errToast('common.error'),
  });

  const current = (session?.user.locale ?? 'en') as Locale;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={i18n.t('settings.language.title')}
      description={i18n.t('settings.language.subtitle')}
    >
      <div className="py-3">
        {/* Rows sit inside a surface-2 container (matches SettingsSheet's
            language picker) so both entry points render identically —
            previously these rows were wrapper-less with a surface-2
            background and drifted from Settings' surface rows. */}
        <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
          {LANGS.map((lang) => {
            const selected = current === lang.code;
            return (
              <PickerRow
                key={lang.code}
                label={lang.label}
                hint={lang.region}
                selected={selected}
                disabled={setLocale.isPending}
                onClick={() => {
                  if (selected) {
                    onOpenChange(false);
                    return;
                  }
                  setLocale.mutate({ locale: lang.code });
                }}
              />
            );
          })}
        </div>
      </div>
      {/* Cancel-only footer — user wanted a way out without picking
          a new lang. Tap-outside also dismisses (per ConfirmSheet rules
          set 2026-05-04). */}
      <div className="px-4 pb-2">
        <Button block variant="pearl" onClick={() => onOpenChange(false)}>
          {i18n.t('common.cancel')}
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * Globe-icon button — drop into a page header. Tapping opens the
 * picker. Caller manages open state so multiple entry points (Admin
 * + Order header) can share one sheet instance if needed.
 */
export function LanguageButton({ onClick }: { onClick: () => void }) {
  const i18n = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={i18n.t('settings.language.aria')}
      className="press flex h-[var(--capsule-h)] w-[var(--capsule-h)] shrink-0 items-center justify-center rounded-[var(--r-pill)] bg-[var(--c-capsule)] text-body-sm"
    >
      🌐
    </button>
  );
}
