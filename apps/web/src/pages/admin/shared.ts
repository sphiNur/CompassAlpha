/**
 * Shared admin helpers (Phase 5 of the 2026-07 frontend audit's admin split).
 */
import { confirmThen } from '../../lib/confirm';

export function nativeConfirm(message: string, ok: () => void): void {
  confirmThen(message, ok);
}
