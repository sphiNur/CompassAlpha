/**
 * The attendance map, loaded on demand: Leaflet (~40 KB) and its tiles
 * only download where a map is on screen.
 */
import { Suspense } from 'react';
import { resilientLazy } from '../../lib/resilientLazy';
import type { GeoMapViewProps } from './GeoMapView';

export type { GeoArea, GeoPoint } from './GeoMapView';

const View = resilientLazy(() => import('./GeoMapView'));

export function GeoMap(props: GeoMapViewProps) {
  const box = props.className ?? 'h-56 w-full overflow-hidden rounded-[var(--r-utility)]';
  return (
    <Suspense fallback={<div className={`${box} animate-pulse bg-[var(--c-surface-2)]`} />}>
      <View {...props} />
    </Suspense>
  );
}
