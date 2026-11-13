/**
 * What the fake camera shows on the clock-in card: a plain head
 * silhouette instead of Chrome's green test pattern. Chrome reads an
 * MJPEG file (JPEG frames one after another) given with
 * --use-file-for-fake-video-capture; global-setup draws it.
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CAMERA_FILE = join(tmpdir(), 'compass-tutorial-camera.mjpeg');

export async function drawCameraFeed(): Promise<void> {
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {},
  );
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 640 } });
    await page.setContent(`<body style="margin:0">
      <svg width="480" height="640" viewBox="0 0 480 640" style="display:block">
        <defs><radialGradient id="bg" cx="50%" cy="40%" r="75%">
          <stop offset="0" stop-color="#d7dde2"/><stop offset="1" stop-color="#8e9aa4"/>
        </radialGradient></defs>
        <rect width="480" height="640" fill="url(#bg)"/>
        <ellipse cx="240" cy="270" rx="110" ry="140" fill="#6d7a85"/>
        <rect x="90" y="430" width="300" height="260" rx="140" fill="#6d7a85"/>
      </svg></body>`);
    const frame = await page.locator('svg').screenshot({ type: 'jpeg', quality: 85 });
    // A few identical frames; Chrome loops the file.
    writeFileSync(CAMERA_FILE, Buffer.concat(Array.from({ length: 10 }, () => frame)));
  } finally {
    await browser.close();
  }
}
