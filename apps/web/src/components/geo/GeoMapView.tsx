/**
 * A small map for attendance locations (2026-11-07): the store's clock-in
 * area (a point and a radius) and, when given, where people were. Leaflet
 * with OpenStreetMap's tiles (owner's choice: free, no key; only managers
 * and people about to clock look at it, which their tile policy allows,
 * with the attribution shown). Loaded only where a map is on screen; see
 * GeoMap.tsx.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './geoMap.css';

export interface GeoArea {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  /** The fix's accuracy: drawn as a faint circle around the point. */
  accuracyM: number | null;
  /** inside / outside the area, or the person's own position now. */
  tone: 'inside' | 'outside' | 'me';
  label?: string;
}

export interface GeoMapViewProps {
  area: GeoArea | null;
  points?: readonly GeoPoint[];
  /** Makes the area's pin draggable; called with where it was dropped. */
  onAreaMove?: (lat: number, lng: number) => void;
  /** Accessible name of the map. */
  label: string;
  className?: string;
}

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'; // i18n-exempt: the tile licence's required attribution

const pinIcon = (cls: string) =>
  L.divIcon({ className: `geo-pin ${cls}`, iconSize: [18, 18], iconAnchor: [9, 9] });

export default function GeoMapView({
  area,
  points = [],
  onAreaMove,
  label,
  className,
}: GeoMapViewProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const moveRef = useRef(onAreaMove);
  moveRef.current = onAreaMove;

  useEffect(() => {
    if (!box.current) return;
    const m = L.map(box.current, {
      zoomControl: true,
      attributionControl: true,
      // The page scrolls with one finger; the map pans with one too, but
      // zooms only with two or the buttons.
      scrollWheelZoom: false,
    });
    m.attributionControl.setPrefix(false);
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // The sheet or card may still be animating to its size.
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  const draggable = onAreaMove !== undefined;
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngBounds[] = [];
    if (area) {
      const circle = L.circle([area.lat, area.lng], {
        radius: area.radiusM,
        className: 'geo-area',
      }).addTo(g);
      // Not circle.getBounds(): it needs the map to have a view already.
      bounds.push(L.latLng(area.lat, area.lng).toBounds(area.radiusM * 2));
      const pin = L.marker([area.lat, area.lng], {
        icon: pinIcon('geo-pin-area'),
        draggable,
        keyboard: false,
      }).addTo(g);
      if (draggable) {
        pin.on('drag', (e) => circle.setLatLng((e as L.LeafletMouseEvent).latlng));
        pin.on('dragend', () => {
          const p = pin.getLatLng();
          moveRef.current?.(p.lat, p.lng);
        });
      }
    }
    for (const p of points) {
      if (p.accuracyM !== null && p.accuracyM > 0) {
        L.circle([p.lat, p.lng], {
          radius: p.accuracyM,
          className: `geo-acc geo-${p.tone}`,
          interactive: false,
        }).addTo(g);
        bounds.push(L.latLng(p.lat, p.lng).toBounds(p.accuracyM * 2));
      }
      const dot = L.marker([p.lat, p.lng], {
        icon: pinIcon(`geo-dot geo-${p.tone}`),
        keyboard: false,
      }).addTo(g);
      if (p.label) dot.bindTooltip(p.label);
      bounds.push(L.latLngBounds([p.lat, p.lng], [p.lat, p.lng]));
    }
    if (bounds.length === 0) return;
    const all = bounds.reduce(
      (a, b) => a.extend(b),
      L.latLngBounds(bounds[0]!.getSouthWest(), bounds[0]!.getNorthEast()),
    );
    m.fitBounds(all, { padding: [24, 24], maxZoom: 18 });
    // Only refit when what is shown changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area?.lat, area?.lng, area?.radiusM, JSON.stringify(points), draggable]);

  return (
    <div
      ref={box}
      role="region"
      aria-label={label}
      // Leaflet's panes and controls use z-index up to 1000: kept inside
      // the map, or they would cover sheets opened over the page.
      className={`isolate ${className ?? 'h-56 w-full overflow-hidden rounded-[var(--r-utility)]'}`}
    />
  );
}
