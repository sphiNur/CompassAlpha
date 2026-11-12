import { Sheet } from '@compass/ui';

/** A photo to show large, with what it is of. */
export type ViewedPhoto = { url: string; label: string };

/**
 * A photo as a small thumbnail that opens it large (DX-HIS-6). Review
 * RUNWEB1-18 (2026-11-12): moved out of the run history so the purchase
 * screen's problem photos open the same way. They were links that opened
 * a new tab, which left the Mini App, and Android's WebView will not open
 * a data: image as a page at all.
 */
export function PhotoThumb({
  url,
  label,
  onOpen,
}: {
  url: string;
  /** Says what the photo is of; also the viewer's title. */
  label: string;
  onOpen: (photo: ViewedPhoto) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => onOpen({ url, label })}
      className="hit-44 relative h-8 w-8 shrink-0 overflow-hidden rounded-[var(--r-pill)] ring-1 ring-[var(--c-divider)]"
    >
      <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
    </button>
  );
}

/** The photo a PhotoThumb opened, in a sheet over the page. */
export function PhotoViewerSheet({
  photo,
  onClose,
}: {
  photo: ViewedPhoto | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!photo} onOpenChange={(open) => !open && onClose()} title={photo?.label ?? ''}>
      {photo ? (
        <img
          src={photo.url}
          alt={photo.label}
          className="mx-auto max-h-[70dvh] w-auto rounded-[var(--r-card)] py-3"
        />
      ) : null}
    </Sheet>
  );
}
