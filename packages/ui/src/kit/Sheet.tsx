import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../cn';
import { useSheetPresence } from '../components/Sheet';

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
   * keyboard over the other choices.
   */
  keepFocus?: boolean;
}

/**
 * A decision or a detail, raised from the bottom edge. Telegram's back
 * button closes it, as does a tap outside.
 */
export function Sheet({ open, onOpenChange, title, children, actions, keepFocus }: SheetProps) {
  useSheetPresence(open, onOpenChange);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={keepFocus ? (e) => e.preventDefault() : undefined}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-lg bg-neutral text-ink',
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
