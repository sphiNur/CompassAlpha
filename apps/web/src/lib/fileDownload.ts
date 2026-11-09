/**
 * Save a file the server serves at `path` (2026-11-05, attendance month
 * export). A Mini App's WebView cannot save a blob or follow a download
 * link, so inside Telegram the file goes through Telegram's own download
 * dialog (Bot API 8.0); older clients open the link in the phone's
 * browser; a plain browser follows the link.
 */
import { API_URL } from './trpc';
import { getTg, isInTelegram } from '../hooks/useTelegram';

export function absoluteUrl(path: string): string {
  return new URL(`${API_URL}${path}`, window.location.origin).href;
}

/** Resolves false when the person cancels Telegram's dialog. */
export function saveFile(path: string, fileName: string): Promise<boolean> {
  const url = absoluteUrl(path);
  const tg = getTg();
  if (isInTelegram() && tg?.downloadFile && tg.isVersionAtLeast?.('8.0')) {
    return new Promise((resolve) => {
      try {
        tg.downloadFile!({ url, file_name: fileName }, (ok) => resolve(ok !== false));
      } catch {
        tg.openLink?.(url);
        resolve(true);
      }
    });
  }
  if (isInTelegram() && tg?.openLink) {
    tg.openLink(url);
    return Promise.resolve(true);
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return Promise.resolve(true);
}
