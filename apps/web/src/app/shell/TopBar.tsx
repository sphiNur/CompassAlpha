import { StoreChip } from '../../components/StoreSwitcher';
import { useI18n } from '../../hooks/useI18n';
import { isInTelegram } from '../../lib/telegram';
import { useAuthStore } from '../../stores/authStore';

/**
 * The top of the screen. Inside Telegram, the platform chrome (Close + bot
 * title + ⋯) is the header, and our own title bar would collide with it:
 * the top is a strip under Telegram's buttons, sized by
 * hooks/useTelegramChromeInsets.ts. In a browser it is our own header.
 *
 * 2026-07-30: the check was `!!window.Telegram`, true in any browser
 * because index.html loads the SDK statically. The app therefore ALWAYS
 * reserved a blank strip for Telegram's chrome and never rendered its own
 * header — no title, no org name, just ~60 px of empty space at the top of
 * every screen outside Telegram. `isInTelegram()` tests real initData.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const i18n = useI18n();
  const orgName = useAuthStore((s) => s.session?.member.orgName);
  if (isInTelegram()) {
    // Reserved strip lets Telegram's chrome (Close + bot title + ⋯)
    // sit on top without overlapping our content.
    //
    // M3.42 (2026-05-22): height is `--app-chrome-reserve` (set by
    // hooks/useTelegramChromeInsets.ts from Telegram WebApp's
    // contentSafeAreaInset / safeAreaInset / platform), with the legacy
    // `calc(--app-safe-top + 36px)` rule as the fallback when the
    // SDK doesn't expose anything (older Telegram clients, web
    // preview wrapped in fake WebApp).
    //
    // iOS env(safe-top) already covers the dynamic island; we add
    // ~36 px for the chrome row itself. On Android the SDK reports
    // a ~56 px row, which the variable now picks up correctly.
    //
    // 2026-07-30: the strip is no longer blank — it carries the
    // current store, sitting where Telegram puts a bot title:
    // between the Close button (left) and the ⋯ overflow (right).
    //
    // Padding is the LARGER of the two chrome pads on BOTH sides,
    // not each side's own value. Telegram's right cluster is wider
    // than Close (96px vs 56px measured on Android), so per-side
    // padding centers the title in the free GAP — about 30px left
    // of the screen's center line, which reads as misaligned right
    // next to Telegram's own screen-centered chrome. Padding both
    // sides by max() puts the title on the true center line while
    // still clearing the wider cluster, so it cannot slide under
    // either button.
    //
    // `paddingTop` drops it below the device safe area so it lands
    // on the button row rather than in the notch — using the SDK's
    // `--app-chrome-safe-top`, the same source the height came
    // from (box-border makes that padding eat the safe-area share
    // of `--app-chrome-reserve`, leaving exactly the button row).
    return (
      <div
        className="flex items-center justify-center"
        style={{
          flexShrink: 0,
          height: 'var(--app-chrome-reserve, calc(var(--app-safe-top) + 36px))',
          background: 'var(--c-bg)',
          paddingTop: 'var(--app-chrome-safe-top, 0px)',
          paddingLeft: 'max(var(--app-chrome-pad-left, 16px), var(--app-chrome-pad-right, 16px))',
          paddingRight: 'max(var(--app-chrome-pad-left, 16px), var(--app-chrome-pad-right, 16px))',
        }}
      >
        <StoreChip />
      </div>
    );
  }
  // Outside Telegram there are no overlay buttons, but the header
  // plays the same role — so the store sits centered here too,
  // between the wordmark and the org name. A 3-column grid with
  // `1fr auto 1fr` keeps the chip on the true centre line no
  // matter how wide the two side labels are; `justify-between`
  // would drift it toward whichever side is shorter.
  return (
    <header
      className="sticky top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-[var(--c-divider)] bg-[var(--c-surface)]"
      style={{
        paddingTop: 'var(--app-safe-top)',
        // Review COREWEB1-31 (2026-11-12): the page's side inset token,
        // not 16px; more on a phone on its side, for the notch.
        paddingLeft: 'max(var(--app-inline-x), var(--app-safe-left))',
        paddingRight: 'max(var(--app-inline-x), var(--app-safe-right))',
        height: 'calc(var(--app-header-h) + var(--app-safe-top))',
      }}
    >
      <span className="truncate text-old-h3 font-semibold">Compass</span>
      <StoreChip />
      {/* The only other way into settings (profile, language, the
          page's own menu actions) is Telegram's gear, which does not
          exist here. */}
      <button
        type="button"
        data-testid="open-settings"
        aria-label={i18n.t('settings.title')}
        onClick={onOpenSettings}
        // V4: hit-44 makes the 14px-tall name tap as 44px. The
        // truncation lives on the inner span: an overflow-hidden
        // button would clip its own tap area.
        className="press hit-44 min-w-0 max-w-full justify-self-end text-old-label text-[var(--c-fg-muted)]"
      >
        <span className="block truncate underline decoration-dotted underline-offset-4">
          {orgName ?? i18n.t('settings.title')}
        </span>
      </button>
    </header>
  );
}
