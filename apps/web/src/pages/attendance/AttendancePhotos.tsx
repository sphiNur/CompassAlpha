/**
 * The photos behind attendance checks: a punch's face and surroundings
 * photos, and a face enrollment's poses. The day sheet, the settings and
 * the review queue show them. Review ATT-23 (2026-11-12): they lived in
 * the first two pages' files, and the review queue imported them from
 * there.
 */
import { useState } from 'react';
import type { EnrollPose } from '@compass/contracts/schemas/faceEnroll';
import { Button, DataState } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { trpc } from '../../lib/trpc';

/** A punch's face and surroundings photos, loaded when asked for. */
export function PunchPhotoStrip({ storeId, punchId }: { storeId: string; punchId: string }) {
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  const photos = trpc.attendance.punchPhotos.useQuery(
    { storeId, punchId },
    { enabled: open, staleTime: Infinity },
  );
  if (!open) {
    return (
      <Button variant="secondary" size="sm" className="self-start" onClick={() => setOpen(true)}>
        {i18n.t('attendance.photo.show')}
      </Button>
    );
  }
  return (
    <DataState query={photos}>
      {(list) => (
        <div className="grid grid-cols-2 gap-2">
          {list.map((ph) => (
            <figure key={ph.kind} className="flex flex-col gap-1">
              <img
                src={ph.src}
                alt={i18n.t(`attendance.photo.${ph.kind}`)}
                className="aspect-[3/4] w-full rounded-[var(--r-utility)] object-cover"
              />
              <figcaption className="text-old-label text-[var(--c-fg-muted)]">
                {i18n.t(`attendance.photo.${ph.kind}`)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </DataState>
  );
}

/**
 * An enrollment's photos, five to a row: the four required poses and any
 * of the rest of ENROLL_POSES (ten in all).
 */
export function EnrollPhotos({
  photos,
  name,
}: {
  photos: { pose: EnrollPose; src: string }[];
  name: string;
}) {
  const i18n = useI18n();
  return (
    <div className="grid grid-cols-5 gap-1">
      {photos.map((p) => (
        <img
          key={p.pose}
          src={p.src}
          alt={i18n.t('attendance.enroll.photoAlt', {
            name,
            pose: i18n.t(`attendance.enroll.pose.${p.pose}`),
          })}
          className="aspect-[3/4] w-full rounded-[var(--r-utility)] object-cover"
        />
      ))}
    </div>
  );
}
