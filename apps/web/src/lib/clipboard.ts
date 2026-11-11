/**
 * Copying text to the clipboard.
 *
 * ADM1-15 (2026-11-11): WebKit, which Telegram uses on iOS, lets a page
 * write the clipboard only while it handles the tap. An invite link
 * exists only once the server has answered, and a copy that waited for
 * it was refused. Pass such text as a promise: the write is asked for
 * during the tap through a ClipboardItem, which waits for the text.
 * Engines without ClipboardItem get a plain write once the text is here.
 *
 * Call it from the tap handler itself, before any `await`.
 */

/**
 * True when the text reached the clipboard; false when the clipboard
 * refused it or there is none. Rejects when `text` rejects, so the
 * caller can report that failure as its own.
 */
export async function copyText(text: string | Promise<string>): Promise<boolean> {
  if (typeof text !== 'string') {
    const asked = askWithPendingText(text);
    const value = await text;
    if (asked && (await asked)) return true;
    // An engine that refuses a pending item may still take a plain write.
    return writePlain(value);
  }
  return writePlain(text);
}

/** The write requested now for text that arrives later, or null when unsupported. */
function askWithPendingText(text: Promise<string>): Promise<boolean> | null {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem !== 'function') return null;
  const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
  // The text's own failure is reported by copyText; this branch only
  // keeps it from also surfacing as an unhandled rejection.
  void blob.catch(() => undefined);
  try {
    return clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(
      () => true,
      () => false,
    );
  } catch {
    // Older engines accept only a ready Blob in a ClipboardItem.
    return null;
  }
}

function writePlain(value: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    return clipboard.writeText(value).then(
      () => true,
      () => false,
    );
  }
  return Promise.resolve(copyWithTextarea(value));
}

/** Old WebViews without the clipboard API: select a hidden field and copy. */
function copyWithTextarea(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(field);
  }
}
