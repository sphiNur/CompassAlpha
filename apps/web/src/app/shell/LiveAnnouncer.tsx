import { useEffect, useState } from 'react';
import { subscribeAnnouncements } from '../../lib/announce';

/**
 * A11Y-12 (2026-10-31): the app's one polite status region. Pages say
 * things through `announce()` / `useAnnounce()` (lib/announce.ts): search
 * and filter result counts, which used to change on screen in silence.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
export function LiveAnnouncer() {
  const [text, setText] = useState('');
  useEffect(() => subscribeAnnouncements(setText), []);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}
