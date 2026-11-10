/**
 * Bridges the app's i18n catalog into @compass/ui's label context
 * (2026-07-30).
 *
 * `@compass/ui` renders a handful of strings itself — QtyControl's
 * aria-labels and its whole quick-pick sheet, DataState's loading/empty/
 * error states, PhotoCapture's hints. The package has no i18n dependency
 * on purpose (host-agnostic design system), so those strings were frozen
 * English on every screen of an app that ships zh/ru/uz. The worst of them
 * was the quick-pick sheet: "Set quantity" / "Unit: kg" / "Custom" /
 * "Set 3 kg" — the fast path for entering a quantity, i.e. the app's
 * single most-used interaction.
 *
 * The strings themselves, and why each one is a getter, are in uiLabels.ts.
 */
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { setDecimalLocale, UiLabelsProvider } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import { uiLabelsFor } from './uiLabels';

export function UiLabelsBridge({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  // RE-CLS-4: number fields read "1,000" by the interface language.
  useEffect(() => {
    setDecimalLocale(i18n.locale);
  }, [i18n.locale]);
  // Memoized on the i18n instance so the provider's merged object stays
  // referentially stable between renders — otherwise every primitive
  // reading the context re-renders on each pass. Safe to memo BECAUSE the
  // fields are getters: staleness of the object identity no longer implies
  // staleness of the strings.
  const labels = useMemo(() => uiLabelsFor(i18n), [i18n]);
  return <UiLabelsProvider labels={labels}>{children}</UiLabelsProvider>;
}
