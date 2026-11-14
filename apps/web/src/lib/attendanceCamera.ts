/**
 * Clock-in photos (2026-11-05): the front camera for the face, then the
 * rear camera for the surroundings. A phone's browser opens one camera at
 * a time, so the two are taken one after the other, a few seconds apart.
 *
 * Live camera first (getUserMedia: the picture is taken now, not picked
 * from the gallery). Where the Telegram client does not pass the camera
 * through to the page, the system camera opens via a file input with
 * `capture`, which phones open straight in camera mode.
 *
 * Photos are scaled to 720 px on the long side, JPEG ~0.72: about
 * 60–120 KB each, enough to recognise a face and a shop.
 */
export type Facing = 'user' | 'environment';

export class CameraError extends Error {
  constructor(public reason: 'unsupported' | 'denied' | 'unavailable') {
    super(`camera ${reason}`);
  }
}

export function isCameraError(e: unknown): e is CameraError {
  return e instanceof CameraError;
}

const MAX_SIDE = 720;
const QUALITY = 0.72;

export async function startCamera(facing: Facing): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 1280 },
      },
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied');
    throw new CameraError('unavailable');
  }
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

function toBase64Jpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide = MAX_SIDE,
): string {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new CameraError('unavailable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', QUALITY);
  const b64 = url.slice(url.indexOf(',') + 1);
  if (!url.startsWith('data:image/jpeg') || b64.length < 100) throw new CameraError('unavailable');
  return b64;
}

/**
 * The video's current frame as a base64 JPEG (not mirrored). Or a frame
 * already taken from it: the face tracker's worker (review MWD-05) reads
 * an ImageBitmap of the video, and the photo is that same frame, so the
 * picture shows the pose or the blink the tracker saw.
 */
export function grabFrame(video: HTMLVideoElement | ImageBitmap, maxSide = MAX_SIDE): string {
  const width = 'videoWidth' in video ? video.videoWidth : video.width;
  const height = 'videoHeight' in video ? video.videoHeight : video.height;
  // A frame this small is a camera that has not really started.
  if (width < 160 || height < 160) throw new CameraError('unavailable');
  return toBase64Jpeg(video, width, height, maxSide);
}

/** A photo from the system camera as a base64 JPEG, scaled down. */
export async function fileToJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return toBase64Jpeg(img, img.naturalWidth, img.naturalHeight);
  } catch (e) {
    if (isCameraError(e)) throw e;
    throw new CameraError('unavailable');
  } finally {
    URL.revokeObjectURL(url);
  }
}
