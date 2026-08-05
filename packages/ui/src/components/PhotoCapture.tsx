import { useRef, useState } from 'react';
import { useUiLabels } from '../labels';
import { cn } from '../cn.js';

/**
 * Result of a `requestPresign` mutation that the host wires through to
 * the API. Shape matches `apps/api/src/services/s3.ts#PresignedPut`.
 */
export interface PresignedUpload {
  url: string;
  publicUrl: string;
  key: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
}

export interface PhotoCaptureProps {
  /** Called once we have a final URL (https for S3, data: for fallback). */
  onCapture: (url: string) => void;
  /** Removes any captured value. */
  onClear?: () => void;
  /** Existing data URI / remote URL to show as preview. */
  value?: string | null;
  /** Max longest-edge in px. Default 1280. */
  maxSize?: number;
  /** JPEG quality 0..1. Default 0.85. */
  quality?: number;
  /** Defaults to "Receipt photo" */
  label?: string;
  className?: string;
  /**
   * Optional uploader. When provided, the file is downscaled to JPEG, a
   * presigned URL is requested, the file is PUT'd, and `onCapture`
   * receives the public https URL. When omitted, we fall back to a
   * data: URI (useful in tests / when S3 isn't configured yet).
   */
  uploader?: PhotoUploader;
}

export interface PhotoUploader {
  /** Ask the API for a presigned PUT URL. */
  requestPresign: (args: { contentType: string; contentLength: number }) => Promise<PresignedUpload>;
}

/**
 * Lightweight photo capture: opens iOS camera (capture="environment") or
 * gallery on tap, downscales to maxSize, encodes as JPEG, then either
 * (a) PUTs to the presigned URL provided by `uploader.requestPresign`
 * and reports the public https URL, or (b) falls back to a data: URI.
 */
export function PhotoCapture({
  onCapture,
  onClear,
  value,
  maxSize = 1280,
  quality = 0.85,
  label,
  className,
  uploader,
}: PhotoCaptureProps) {
  // 2026-07-30: label / remove / hint / uploading were English literals.
  // See packages/ui/src/labels.tsx.
  const labels = useUiLabels();
  const effectiveLabel = label ?? labels.photoLabel;
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImage(url);
      URL.revokeObjectURL(url);
      const blob = await encodeJpegBlob(img, maxSize, quality);

      if (uploader) {
        const presigned = await uploader.requestPresign({
          contentType: 'image/jpeg',
          contentLength: blob.size,
        });
        const res = await fetch(presigned.url, {
          method: 'PUT',
          headers: presigned.requiredHeaders,
          body: blob,
        });
        if (!res.ok) {
          throw new Error(`Upload failed (${res.status})`);
        }
        onCapture(presigned.publicUrl);
      } else {
        onCapture(await blobToDataUrl(blob));
      }
    } catch (err) {
      setError((err as Error).message ?? 'Failed to upload');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <span className="text-label font-semibold text-[var(--c-fg-muted)]">{effectiveLabel}</span>
      {value ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt={effectiveLabel}
            className="block max-h-40 w-auto rounded-[var(--r-card)] ring-hairline"
          />
          {onClear ? (
            <button
              type="button"
              onClick={onClear}
              // Dense tier (28px) + the scrim tokens — this button sits
              // over an arbitrary photo, so it needs a theme-invariant
              // veil rather than a surface token (capsule pass).
              className="press absolute right-2 top-2 inline-flex h-[var(--control-h-xs)] w-[var(--control-h-xs)] items-center justify-center rounded-full bg-[var(--c-scrim-strong)] text-[var(--c-on-scrim)]"
              aria-label={labels.photoRemove}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={cn(
            'press flex h-32 w-full flex-col items-center justify-center gap-1 rounded-[var(--r-card)]',
            'border-2 border-dashed border-[var(--c-divider)] bg-[var(--c-surface-2)]',
            'text-[var(--c-fg-muted)]',
            busy && 'opacity-60',
          )}
        >
          <span className="text-display" aria-hidden>
            📷
          </span>
          <span className="text-body-sm">{busy ? labels.uploading : labels.photoHint}</span>
        </button>
      )}
      {error ? <span className="text-label text-[var(--c-danger)]">{error}</span> : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

function encodeJpegBlob(img: HTMLImageElement, maxSize: number, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas 2D unsupported'));
      return;
    }
    ctx.fillStyle = '#ffffff'; // jpg has no alpha; white-bg looks cleanest
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob produced null'))),
      'image/jpeg',
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('FileReader failed'));
    r.readAsDataURL(blob);
  });
}
