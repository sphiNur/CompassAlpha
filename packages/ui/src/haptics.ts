/**
 * Telegram's haptic feedback, for the kit's own controls (UI overhaul B,
 * 2026-11-15): a choice changed (Segmented, PickerRow, Switch, Checkbox)
 * is a selection tick, a quantity step a light tap. Outside Telegram, or
 * on a client without the call, nothing happens. The web app's
 * `haptic()` (apps/web/src/lib/telegram.ts) is the same calls for pages.
 */
interface HapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged?(): void;
}

function feedback(): HapticFeedback | undefined {
  const w = globalThis as { Telegram?: { WebApp?: { HapticFeedback?: HapticFeedback } } };
  return w.Telegram?.WebApp?.HapticFeedback;
}

/** A choice changed: a tick, lighter than a tap. */
export function hapticSelection(): void {
  try {
    feedback()?.selectionChanged?.();
  } catch {
    /* never let haptics throw past the control */
  }
}

/** A step or a press. */
export function hapticImpact(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  try {
    feedback()?.impactOccurred(style);
  } catch {
    /* never let haptics throw past the control */
  }
}
