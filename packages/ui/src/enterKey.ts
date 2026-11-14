/**
 * Enter that finishes what was typed, not one that picks an IME candidate
 * (modern-web-guidance: ime-safe-enter-submit). A Chinese, Japanese or
 * Korean input method confirms its candidate with Enter while composing;
 * acting on that Enter saved a half-typed name (review MWA-01).
 * `isComposing` is not reported by Safari's keydown, so the composing
 * keyCode 229 counts too.
 */
type EnterLike = {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
};

export function isCommitEnter(event: EnterLike): boolean {
  if (event.key !== 'Enter') return false;
  if (event.isComposing || event.nativeEvent?.isComposing) return false;
  return event.keyCode !== 229;
}
