/** Types for tailwind.preset.js, which tests and TypeScript hosts import. */
export declare const FONT_SIZE_SCALE: Record<
  string,
  [size: string, extra: { lineHeight: string; letterSpacing?: string; fontWeight?: string }]
>;

declare const preset: {
  theme: { extend: { fontSize: typeof FONT_SIZE_SCALE } };
};
export default preset;
