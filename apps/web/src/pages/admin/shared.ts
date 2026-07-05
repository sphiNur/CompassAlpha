/**
 * Shared admin helpers (Phase 5 — FRONTEND_AUDIT_2026-07.md admin split).
 */
import { getTg } from '../../hooks/useTelegram';

export function nativeConfirm(message: string, ok: () => void): void {
  const tg = getTg();
  if (tg) {
    // M1.7-fix (2026-05-07, audit HIGH #8): iOS Telegram's
    // showConfirm renders the literal "\n\n" rather than a paragraph
    // break, so a confirm message like "Remove X?\n\nThis revokes
    // bindings…" looked like garbage. Web's native confirm() does
    // honor newlines, so callers were writing them in good faith.
    // Normalize: collapse runs of whitespace (including \n\n) into a
    // single space when delivering to Telegram. Web preview keeps
    // the original (paragraph-friendly) text so devs see the same
    // copy they wrote.
    const oneLine = message.replace(/\s*\n\s*\n\s*/g, ' — ').replace(/\n/g, ' ');
    tg.showConfirm(oneLine, (yes: boolean) => {
      if (yes) ok();
    });
  } else if (confirm(message)) {
    ok();
  }
}
