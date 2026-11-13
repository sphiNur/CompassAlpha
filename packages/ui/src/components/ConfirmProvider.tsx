import { useEffect, useState, type ReactNode } from 'react';
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
  // A plain subscription. With useSyncExternalStore (plus the render-time
  // setShown below) the provider did not re-render after the sheet's own
  // Cancel answered, and the question stayed open (e2e, count stock).
  const [request, setRequest] = useState(queue.current);
  useEffect(() => {
    setRequest(queue.current());
    return queue.subscribe(() => setRequest(queue.current()));
  }, [queue]);
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
