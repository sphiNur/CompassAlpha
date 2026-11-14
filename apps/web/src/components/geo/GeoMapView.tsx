/**
 * A small map for attendance locations (2026-11-07): the store's clock-in
 * area (a point and a radius) and, when given, where people were. Leaflet
 * with OpenStreetMap's tiles (owner's choice: free, no key; only managers
 * and people about to clock look at it, which their tile policy allows,
 * with the attribution shown). Loaded only where a map is on screen; see
 * GeoMap.tsx.
 *
 * 2026-11-15: no HTML strings reach Leaflet. Under the enforced Trusted
 * Types policy (lib/trustedTypes.ts) every `innerHTML` with a string is
 * blocked, and Leaflet writes one for the zoom buttons, the attribution,
 * a div icon and a string tooltip. So the zoom buttons and attribution are
 * built from elements here, the pins get an element, and a tooltip is its
 * label as text (a person's name is no longer read as HTML either).
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
const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';

/** A div icon whose content is an element, so Leaflet writes no HTML. */
const pinIcon = (cls: string) =>
  L.divIcon({
    className: `geo-pin ${cls}`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    html: document.createElement('span'),
  });

/** A tooltip's content as text, never HTML. */
function textNode(text: string): HTMLElement {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

/** Leaflet's zoom control with its buttons' text set as text. */
const TextZoom = L.Control.Zoom.extend({
  _createButton(
    this: L.Control.Zoom & { _refocusOnMap: () => void },
    text: string,
    title: string,
    className: string,
    container: HTMLElement,
    fn: () => void,
  ): HTMLAnchorElement {
    const link = L.DomUtil.create('a', className, container);
    link.textContent = text;
    link.href = '#';
    link.title = title;
    link.setAttribute('role', 'button');
    link.setAttribute('aria-label', title);
    L.DomEvent.disableClickPropagation(link);
    L.DomEvent.on(link, 'click', L.DomEvent.stop);
    L.DomEvent.on(link, 'click', fn, this);
    L.DomEvent.on(link, 'click', this._refocusOnMap, this);
    return link;
  },
}) as unknown as new (options: L.Control.ZoomOptions) => L.Control.Zoom;

/** The tiles' required attribution ("© OpenStreetMap"), built from elements. */
const OsmAttribution = L.Control.extend({
  onAdd(): HTMLElement {
    const box = L.DomUtil.create('div', 'leaflet-control-attribution');
    const link = document.createElement('a');
    link.href = OSM_COPYRIGHT;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'OpenStreetMap'; // i18n-exempt: the tile licence's required attribution
    box.append('© ', link);
    L.DomEvent.disableClickPropagation(box);
    return box;
  },
}) as unknown as new (options: L.ControlOptions) => L.Control;

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
      // Leaflet's own controls write HTML strings; ours below do not.
      zoomControl: false,
      attributionControl: false,
      // The page scrolls with one finger; the map pans with one too, but
      // zooms only with two or the buttons.
      scrollWheelZoom: false,
    });
    new TextZoom({ position: 'topleft', zoomInText: '+', zoomOutText: '−' }).addTo(m);
    new OsmAttribution({ position: 'bottomright' }).addTo(m);
    L.tileLayer(TILES, { maxZoom: 19 }).addTo(m);
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
      if (p.label) dot.bindTooltip(textNode(p.label));
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
