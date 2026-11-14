import { describe, expect, test } from 'bun:test';
import { allowedHtml, allowedScriptUrl } from '../trustedTypes';

const ORIGIN = 'https://app.example';

describe('allowedScriptUrl (review MWD-13)', () => {
  test('lets through the service worker and built files on this origin', () => {
    expect(allowedScriptUrl('/sw.js', ORIGIN, false)).toBe(`${ORIGIN}/sw.js`);
    expect(allowedScriptUrl('/assets/vision_wasm_internal-abc.js', ORIGIN, false)).toBe(
      `${ORIGIN}/assets/vision_wasm_internal-abc.js`,
    );
    expect(allowedScriptUrl(`${ORIGIN}/assets/faceWorker-1.js`, ORIGIN, false)).toBe(
      `${ORIGIN}/assets/faceWorker-1.js`,
    );
  });

  test('refuses other origins, other paths and non-http schemes', () => {
    expect(allowedScriptUrl('https://evil.example/assets/x.js', ORIGIN, false)).toBeNull();
    expect(allowedScriptUrl('/src/main.tsx', ORIGIN, false)).toBeNull();
    expect(allowedScriptUrl('/assetsx/a.js', ORIGIN, false)).toBeNull();
    expect(allowedScriptUrl('data:text/javascript,alert(1)', ORIGIN, false)).toBeNull();
    expect(allowedScriptUrl('javascript:alert(1)', ORIGIN, false)).toBeNull();
    expect(allowedScriptUrl('blob:https://app.example/1', ORIGIN, false)).toBeNull();
  });

  test('dev lets any same-origin URL through, still no other origin', () => {
    expect(allowedScriptUrl('/src/main.tsx', ORIGIN, true)).toBe(`${ORIGIN}/src/main.tsx`);
    expect(allowedScriptUrl('https://evil.example/x.js', ORIGIN, true)).toBeNull();
  });
});

describe('allowedHtml (2026-11-15: the attendance map)', () => {
  test("lets through only Leaflet's SVG check", () => {
    expect(allowedHtml('<svg/>')).toBe('<svg/>');
  });
  test('refuses any other HTML, the empty string included', () => {
    expect(allowedHtml('')).toBeNull();
    expect(allowedHtml('<svg/><img src=x onerror=alert(1)>')).toBeNull();
    expect(allowedHtml('<span aria-hidden="true">+</span>')).toBeNull();
    expect(allowedHtml('<b>Ali</b>')).toBeNull();
  });
});
