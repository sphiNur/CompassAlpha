import { currencyOf } from '../lib/format';
import { useAuthStore } from '../stores/authStore';

/**
 * The workspace's currency code. Review RUNWEB2-25 (2026-11): a dozen
 * screens read it with an `?? 'UZS'` of their own; the fallback lives in
 * currencyOf.
 */
export function useCurrency(): string {
  return useAuthStore((state) => currencyOf(state.session));
}
