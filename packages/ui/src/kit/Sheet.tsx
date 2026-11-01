import * as Dialog from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import { cn } from '../cn';
import { useSheetPresence } from '../components/Sheet';
import { useSheetFocus } from '../sheetFocus';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What this sheet is asking or showing. Always present: it names the dialog. */
  title: ReactNode;
  children?: ReactNode;
  /** The sheet's actions, pinned under the content. One primary at most. */
  actions?: ReactNode;
  /**
   * Leave focus where it is when the sheet opens. For sheets with a text
   * field the person may not want first: focusing it would raise the
   * keyboard over the other choices. DX-IX-2: the sheet itself takes
   * focus then, so it does not stay on the page behind.
   */
  keepFocus?: boolean;
}

/**
 * A decision or a detail, raised from the bottom edge. Telegram's back
 * button closes it, as does a tap outside.
 */
export function Sheet({ open, onOpenChange, title, children, actions, keepFocus }: SheetProps) {
  useSheetPresence(open, onOpenChange);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const focus = useSheetFocus(open, contentRef, !!keepFocus);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40" />
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          tabIndex={-1}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-lg bg-surface text-ink',
            'shadow-raised outline-none',
            'data-[state=open]:animate-[slideUp_var(--t-base)_var(--easing)]',
          )}
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <Dialog.Title className="shrink-0 px-page pb-md pt-xl text-h2">{title}</Dialog.Title>
          {children ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-page pb-lg">
              {children}
            </div>
          ) : null}
          {actions ? (
            <div className="flex shrink-0 flex-col gap-sm px-page pb-lg pt-sm">{actions}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
