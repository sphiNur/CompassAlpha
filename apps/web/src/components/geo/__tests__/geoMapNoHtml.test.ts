/**
 * 2026-11-15: under the enforced Trusted Types policy, Leaflet's
 * `innerHTML` writes with a string are blocked, and the attendance map did
 * not load. GeoMapView hands Leaflet elements, never HTML strings.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '..', 'GeoMapView.tsx'), 'utf8');

describe('the attendance map writes no HTML strings', () => {
  test("Leaflet's own zoom and attribution controls are off", () => {
    expect(src).toMatch(/zoomControl: false,/);
    expect(src).toMatch(/attributionControl: false,/);
    expect(src).not.toMatch(/\.innerHTML\s*=/);
    expect(src).not.toMatch(/setPrefix|attribution:/);
  });
  test('div icons get an element and tooltips text', () => {
    expect(src).toMatch(/html: document\.createElement\('span'\)/);
    expect(src).toMatch(/bindTooltip\(textNode\(/);
    expect(src).not.toMatch(/bindTooltip\(p\.label\)/);
    expect(src).not.toMatch(/bindPopup/);
  });
});
