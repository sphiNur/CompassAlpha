import { useEffect, useState } from 'react';
import { Button, Field, Sheet } from '@compass/ui/kit';
import type { useI18n } from '../../../hooks/useI18n';

export interface ConfirmConfig {
  title: string;
  /** What will happen, in a sentence or a few lines of figures. */
  body: string;
  confirmLabel: string;
  /** The action cannot be taken back, or throws work away. */
  danger: boolean;
  /** The action is recorded with a reason and cannot go ahead without one. */
  requireReason: boolean;
  /**
   * A reason may be given but is not asked for: the field stays folded
   * away until wanted, because a field that is always there gets "asdf".
   */
  reasonOptional?: boolean;
  reasonPlaceholder?: string;
  isPending: boolean;
  run: () => void;
}

export interface ConfirmSheetProps {
  config: ConfirmConfig | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  i18n: ReturnType<typeof useI18n>;
}

/**
 * The one question the run screen asks before a step that matters:
 * finishing a trip, cancelling it, stepping back a phase, taking a
 * delivery back. One primary button that says what it does.
 */
export function ConfirmSheet({
  config,
  reason,
  onReasonChange,
  onCancel,
  i18n,
}: ConfirmSheetProps) {
  const [reasonOpen, setReasonOpen] = useState(false);
  // A reason field opened for one question must not be open for the next.
  useEffect(() => {
    if (!config) setReasonOpen(false);
  }, [config]);

  const required = !!config?.requireReason;
  const optional = !!config && !required && !!config.reasonOptional;
  const showField = required || (optional && reasonOpen);
  const ready = !required || reason.trim().length > 0;

  return (
    <Sheet
      open={!!config}
      onOpenChange={(open) => {
        // Not while the request is in flight: closing would discard the
        // typed reason, and a failure would then have nothing to retry with.
        if (!open && !config?.isPending) onCancel();
      }}
      title={config?.title ?? ''}
      // A required reason is the first thing to do; otherwise leave the
      // keyboard down so the question can be read.
      keepFocus={!required}
      actions={
        <>
          <Button
            variant={config?.danger ? 'danger' : 'primary'}
            data-testid="confirm-action"
            busy={config?.isPending}
            disabled={!ready}
            onClick={() => config?.run()}
          >
            {config?.confirmLabel ?? ''}
          </Button>
          <Button variant="ghost" disabled={config?.isPending} onClick={onCancel}>
            {i18n.t('common.cancel')}
          </Button>
        </>
      }
    >
      {config ? (
        <div className="flex flex-col gap-lg">
          <p className="whitespace-pre-line text-body text-secondary">{config.body}</p>
          {showField ? (
            <Field
              label={i18n.t('run.label.reasonForChange') as string}
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder={
                config.reasonPlaceholder ?? (i18n.t('run.label.reasonPlaceholder') as string)
              }
              autoFocus={required}
            />
          ) : null}
          {optional && !reasonOpen ? (
            <Button
              variant="ghost"
              inline
              className="self-start"
              onClick={() => setReasonOpen(true)}
            >
              {i18n.t('run.label.addReasonOptional')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
