/**
 * 2026-10-21 FE-10: what DataState's error banner says.
 *
 * `query.error.message` is usually a server i18n key
 * (`order.errors.notFound`) or a transport string ("Failed to fetch").
 * Showing it raw put untranslated keys in front of users, so the host's
 * `translateError` (UiLabels) maps it first; a blank result falls back to
 * the generic "unknown error" copy.
 */
export function resolveDataStateError(
  error: { message?: string } | null | undefined,
  translateError: (message: string | undefined) => string | undefined,
  fallback: string,
): string {
  const raw =
    typeof error?.message === 'string' && error.message.trim() ? error.message : undefined;
  let text: string | undefined;
  try {
    text = translateError(raw);
  } catch {
    text = undefined;
  }
  return text && text.trim() ? text : fallback;
}
