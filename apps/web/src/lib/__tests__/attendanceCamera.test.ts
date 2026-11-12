/**
 * Review TEST3-08 (2026-11-10): the camera behind the punch and the face
 * enrollment had no test. Which problem a refusal is (the sheet tells the
 * person what to do about each), and which frames are not worth sending.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { fileToJpeg, grabFrame, isCameraError, startCamera, stopCamera } from '../attendanceCamera';

const g = globalThis as Record<string, unknown>;
const saved = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  document: g.document,
  Image: g.Image,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};

afterEach(() => {
  if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  g.document = saved.document;
  g.Image = saved.Image;
  URL.createObjectURL = saved.createObjectURL;
  URL.revokeObjectURL = saved.revokeObjectURL;
});

function browser(getUserMedia?: (c: MediaStreamConstraints) => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: getUserMedia ? { mediaDevices: { getUserMedia } } : {},
    configurable: true,
    writable: true,
  });
}

/** Why `fn` failed, as the camera sheet sees it. */
async function reason(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (isCameraError(e)) return e.reason;
    throw e;
  }
  return 'no error';
}

const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(400);

/**
 * A document whose canvases record their size and what was drawn, and
 * encode to `encoded`; `context: false` is a canvas without a 2D context.
 */
function canvases(encoded = JPEG, context = true) {
  const made: Array<{ width: number; height: number; drawn: unknown[]; asked: unknown[] }> = [];
  g.document = {
    createElement(tag: string) {
      expect(tag).toBe('canvas');
      const canvas = {
        width: 0,
        height: 0,
        drawn: [] as unknown[],
        asked: [] as unknown[],
        getContext: () =>
          context ? { drawImage: (...args: unknown[]) => void canvas.drawn.push(args) } : null,
        toDataURL: (...args: unknown[]) => {
          canvas.asked.push(args);
          return encoded;
        },
      };
      made.push(canvas);
      return canvas;
    },
  };
  return made;
}

const video = (videoWidth: number, videoHeight: number) =>
  ({ videoWidth, videoHeight }) as HTMLVideoElement;

describe('startCamera', () => {
  test('asks for the camera facing the given way, without sound', async () => {
    const asked: MediaStreamConstraints[] = [];
    const stream = { id: 'stream' };
    browser(async (c) => {
      asked.push(c);
      return stream;
    });
    expect(await startCamera('user')).toBe(stream as unknown as MediaStream);
    expect(asked).toEqual([
      {
        audio: false,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      },
    ]);
  });

  test('a browser without getUserMedia is unsupported', async () => {
    browser();
    expect(await reason(() => startCamera('user'))).toBe('unsupported');
    // mediaDevices without getUserMedia: an insecure page or an old web view.
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: {} },
      configurable: true,
      writable: true,
    });
    expect(await reason(() => startCamera('user'))).toBe('unsupported');
  });

  test('a refusal is denied; any other failure is unavailable', async () => {
    const failing = (name: string) => async () => {
      throw Object.assign(new Error(name), { name });
    };
    const reasons: Record<string, string> = {};
    for (const name of [
      'NotAllowedError',
      'SecurityError',
      'NotFoundError',
      'NotReadableError',
      'OverconstrainedError',
    ]) {
      browser(failing(name));
      reasons[name] = await reason(() => startCamera('environment'));
    }
    expect(reasons).toEqual({
      NotAllowedError: 'denied',
      SecurityError: 'denied',
      NotFoundError: 'unavailable',
      NotReadableError: 'unavailable',
      OverconstrainedError: 'unavailable',
    });
  });
});

describe('stopCamera', () => {
  test('stops every track, and takes no stream as nothing to stop', () => {
    const stopped: string[] = [];
    const track = (id: string) => ({ stop: () => void stopped.push(id) });
    stopCamera({ getTracks: () => [track('video'), track('other')] } as unknown as MediaStream);
    expect(stopped).toEqual(['video', 'other']);
    expect(() => stopCamera(null)).not.toThrow();
  });
});

describe('grabFrame', () => {
  test('a frame under 160 px is a camera that has not really started', async () => {
    canvases();
    expect(await reason(() => grabFrame(video(159, 480)))).toBe('unavailable');
    expect(await reason(() => grabFrame(video(640, 0)))).toBe('unavailable');
  });

  test('the long side is scaled to 720 px, a JPEG at 0.72, without its data-URL prefix', () => {
    const made = canvases();
    const frame = video(1280, 960);
    expect(grabFrame(frame)).toBe('A'.repeat(400));
    expect(made[0]).toMatchObject({ width: 720, height: 540 });
    expect(made[0]!.drawn).toEqual([[frame, 0, 0, 720, 540]]);
    expect(made[0]!.asked).toEqual([['image/jpeg', 0.72]]);
  });

  test('a smaller frame is kept as it is; a caller can ask for less', () => {
    const made = canvases();
    grabFrame(video(640, 480));
    grabFrame(video(960, 1280), 320);
    expect(made.map(({ width, height }) => [width, height])).toEqual([
      [640, 480],
      [240, 320],
    ]);
  });

  test('no 2D context, no JPEG encoder or an empty picture: unavailable', async () => {
    canvases(JPEG, false);
    expect(await reason(() => grabFrame(video(640, 480)))).toBe('unavailable');
    // Browsers without a JPEG encoder answer with PNG.
    canvases('data:image/png;base64,' + 'A'.repeat(400));
    expect(await reason(() => grabFrame(video(640, 480)))).toBe('unavailable');
    canvases('data:image/jpeg;base64,AAAA');
    expect(await reason(() => grabFrame(video(640, 480)))).toBe('unavailable');
  });
});

describe('fileToJpeg', () => {
  /** An Image that decodes to the given size, or fails to decode. */
  function images(size: { width: number; height: number } | 'broken') {
    const urls: string[] = [];
    URL.createObjectURL = () => {
      urls.push('blob:photo');
      return 'blob:photo';
    };
    URL.revokeObjectURL = (url: string) => void urls.push(`revoked ${url}`);
    g.Image = class {
      src = '';
      decoding = '';
      naturalWidth = size === 'broken' ? 0 : size.width;
      naturalHeight = size === 'broken' ? 0 : size.height;
      decode() {
        return size === 'broken' ? Promise.reject(new Error('EncodingError')) : Promise.resolve();
      }
    };
    return urls;
  }

  test('a photo from the system camera is scaled like a frame, and its URL freed', async () => {
    const made = canvases();
    const urls = images({ width: 3000, height: 4000 });
    expect(await fileToJpeg(new File(['x'], 'photo.jpg'))).toBe('A'.repeat(400));
    expect(made[0]).toMatchObject({ width: 540, height: 720 });
    expect(urls).toEqual(['blob:photo', 'revoked blob:photo']);
  });

  test('a file that is not a picture is unavailable, and its URL still freed', async () => {
    canvases();
    const urls = images('broken');
    expect(await reason(() => fileToJpeg(new File(['x'], 'notes.txt')))).toBe('unavailable');
    expect(urls).toEqual(['blob:photo', 'revoked blob:photo']);
  });
});
