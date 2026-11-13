import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { ConfirmContext } from '../confirm';
import { createConfirmQueue } from '../confirmQueue';
import { ConfirmSheet } from './ConfirmSheet';

/**
 * UX-07 (2026-11-14): renders the one ConfirmSheet that `useConfirm()`
 * opens, below everything it wraps. Mount it inside UiLabelsProvider so
 * the sheet's Cancel is translated. Cancel is always offered, as the
 * native confirm had it; a `danger` question starts on it.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(createConfirmQueue);
  const request = useSyncExternalStore(queue.subscribe, queue.current, queue.current);
  // The last question stays rendered while the sheet slides away.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) setShown(request);
  return (
    <ConfirmContext.Provider value={queue.ask}>
      {children}
      {shown ? (
        <ConfirmSheet
          open={!!request}
          title={shown.title}
          body={shown.body}
          confirmLabel={shown.confirmLabel}
          danger={shown.danger}
          showCancelInSheet
          onConfirm={() => queue.answer(true)}
          onCancel={() => queue.answer(false)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}
