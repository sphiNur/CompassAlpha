import { useI18n } from '../../hooks/useI18n';
import { usePageMainButtonState } from '../../hooks/usePageMainButton';
import { focusFirst } from '../../lib/focusFirst';

/**
 * DX-IX-5 (2026-11-01): the page's main button and the bottom nav come
 * after the whole list in the DOM, 40+ Tab presses away. Two links, shown
 * only while focused, jump there first (WCAG 2.4.1). Visual order stays.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
export function SkipLinks({ hasNav }: { hasNav: boolean }) {
  const i18n = useI18n();
  const mainButton = usePageMainButtonState();
  // Review COREWEB1-25 (2026-11-11): selectors tried in order, so the
  // current tab wins over the first one (focusFirst).
  const jump =
    (...selectors: string[]) =>
    () => {
      focusFirst(selectors);
    };
  const linkClass =
    'sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded-[var(--r-pill)] ' +
    'focus:bg-[var(--c-surface)] focus:px-4 focus:py-2 focus:text-old-h3 focus:text-[var(--c-action)] focus:shadow-sheet';
  return (
    <>
      {mainButton?.visible ? (
        <button
          type="button"
          className={linkClass}
          onClick={jump('[data-testid="page-main-button"]')}
        >
          {i18n.t('shell.skip.mainAction')}
        </button>
      ) : null}
      {hasNav ? (
        <button
          type="button"
          className={linkClass}
          onClick={jump(
            '[data-testid="primary-nav"] [aria-current="page"]',
            '[data-testid="primary-nav"] button',
          )}
        >
          {i18n.t('shell.skip.nav')}
        </button>
      ) : null}
    </>
  );
}
