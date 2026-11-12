/**
 * Shared admin helpers (Phase 5 of the 2026-07 frontend audit's admin split).
 */
import { confirmThen } from '../../lib/confirm';

/**
 * confirmThen (lib/confirm) under an older name. Review ADM1-30
 * (2026-11-12): the admin screens call confirmThen; only the attendance
 * settings still import this. Remove it once they do.
 */
export function nativeConfirm(message: string, ok: () => void): void {
  confirmThen(message, ok);
}
