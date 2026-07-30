import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

/**
 * Localizable copy owned by the design system (2026-07-30).
 *
 * THE PROBLEM
 *
 * `@compass/ui` has no i18n dependency on purpose — it's meant to work in
 * any host (apps/web today, a future admin tool, a kitchen display), and
 * QtyControl's own docblock says so. The consequence nobody accounted for
 * is that every string a primitive renders ITSELF was frozen in English,
 * and those primitives are on every screen:
 *
 *   QtyControl    aria-label "Decrement" / "Increment" /
 *                 "Quantity 0.5 kg — tap to pick", and the whole quick-pick
 *                 sheet ("Set quantity", "Unit: kg", "Custom", "Set 3 kg")
 *   DataState     "No data" / "Nothing here yet" / "Something went wrong"
 *   PhotoCapture  "Receipt photo" / "Remove photo" / "Tap to take a photo"
 *
 * The quick-pick sheet is the worst of these: it's the fast path for
 * entering a quantity on the order screen, i.e. the single most-used
 * interaction in the app, and it was entirely English inside a Chinese UI.
 *
 * THE SHAPE
 *
 * Threading a `labels` prop through 8+ call sites would work but every new
 * call site can forget it, which is how we got here. Instead the host
 * populates this context ONCE at the app root; primitives read what they
 * need. Defaults are the current English strings, so a host that doesn't
 * provide the context behaves exactly as before — @compass/ui stays
 * dependency-free and independently usable.
 *
 * Adding a string: add the field here with an English default, read it via
 * `useUiLabels()` in the component, and map it in the host's provider.
 */
export interface UiLabels {
  // --- QtyControl ---
  /** aria-label for the − button. */
  decrement: string;
  /** aria-label for the + button. */
  increment: string;
  /**
   * aria-label for the tappable value in the middle. Receives the
   * formatted value already suffixed with the unit, e.g. "0.5 公斤".
   */
  quantityPick: (valueWithUnit: string) => string;
  /** Quick-pick sheet title when the caller passes no `pickTitle`. */
  setQuantity: string;
  /** Quick-pick sheet subtitle. Receives the localized unit label. */
  unitIs: (unit: string) => string;
  /** Eyebrow above the quick-pick sheet's free-entry input. */
  custom: string;
  /** Quick-pick confirm button. Receives value + unit, e.g. "3 公斤". */
  setValue: (valueWithUnit: string) => string;

  // --- DataState ---
  errorTitle: string;
  errorUnknown: string;
  emptyNoData: string;
  emptyNothingYet: string;

  // --- PhotoCapture ---
  photoLabel: string;
  photoRemove: string;
  photoHint: string;
  uploading: string;
}

export const DEFAULT_UI_LABELS: UiLabels = {
  decrement: 'Decrement',
  increment: 'Increment',
  quantityPick: (v) => `Quantity ${v} — tap to pick`,
  setQuantity: 'Set quantity',
  unitIs: (unit) => `Unit: ${unit}`,
  custom: 'Custom',
  setValue: (v) => `Set ${v}`,
  errorTitle: 'Something went wrong',
  errorUnknown: 'Unknown error',
  emptyNoData: 'No data',
  emptyNothingYet: 'Nothing here yet',
  photoLabel: 'Receipt photo',
  photoRemove: 'Remove photo',
  photoHint: 'Tap to take a photo',
  uploading: 'Uploading…',
};

const UiLabelsContext = createContext<UiLabels>(DEFAULT_UI_LABELS);

/**
 * Host-side provider. Pass a PARTIAL override — anything omitted keeps its
 * English default, so a host can adopt this incrementally instead of
 * having to translate every field before the provider is useful.
 */
export function UiLabelsProvider({
  labels,
  children,
}: {
  labels: Partial<UiLabels>;
  children: ReactNode;
}) {
  // Merge via property DESCRIPTORS, not spread.
  //
  // A host whose catalog loads lazily (apps/web does) has to defer the
  // lookup, and the natural way to express that while keeping
  // `labels.custom` reading as a plain string is a getter. Object spread
  // INVOKES getters and stores their result — which would re-freeze
  // exactly the values the host went to the trouble of making lazy.
  // Copying descriptors keeps getters as getters.
  //
  // Memoized on the incoming object so primitives reading the context
  // don't re-render on every host render.
  const value = useMemo(
    () =>
      Object.defineProperties(
        {} as UiLabels,
        {
          ...Object.getOwnPropertyDescriptors(DEFAULT_UI_LABELS),
          ...Object.getOwnPropertyDescriptors(labels),
        },
      ),
    [labels],
  );
  return <UiLabelsContext.Provider value={value}>{children}</UiLabelsContext.Provider>;
}

export function useUiLabels(): UiLabels {
  return useContext(UiLabelsContext);
}
