/**
 * The "+ add" sheet's expense, in its expense mode (M3.44): what it was,
 * typed or started from a saved expense, and its optional unit.
 */
import { Button, Field, FieldGroup, Input } from '@compass/ui';
import { useI18n } from '../../../hooks/useI18n';
import type { AddItemDraft, ExpenseTemplate } from './drafts';

export function ExpenseIdentity({
  draft,
  onChange,
  templates,
  onPickTemplate,
}: {
  draft: AddItemDraft;
  onChange: (d: AddItemDraft) => void;
  templates: ExpenseTemplate[];
  onPickTemplate: (template: ExpenseTemplate) => void;
}) {
  const i18n = useI18n();
  return (
    <>
      <Field label={i18n.t('run.action.addExpense.labelInput')}>
        <Input
          value={draft.label}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
          placeholder={i18n.t('run.action.addExpense.labelPlaceholder')}
          autoFocus
        />
      </Field>
      <Field label={i18n.t('run.action.addExpense.unitHint')}>
        <Input
          value={draft.unitHint}
          onChange={(e) => onChange({ ...draft, unitHint: e.target.value })}
          placeholder={i18n.t('run.action.addExpense.unitHintPlaceholder')}
        />
      </Field>
      {templates.length > 0 ? (
        <FieldGroup label={i18n.t('run.action.addExpense.templates')}>
          {/* RUNWEB2-23: kit buttons with a 44px tap (the pills were 22px
              tall); 12px between wrapped rows keeps the taps apart
              (DX-VIS-8). */}
          <div className="flex flex-wrap gap-x-1.5 gap-y-3">
            {templates.map((tpl) => (
              <Button
                key={tpl.id}
                variant="secondary"
                size="sm"
                onClick={() => onPickTemplate(tpl)}
              >
                {tpl.label}
              </Button>
            ))}
          </div>
        </FieldGroup>
      ) : null}
    </>
  );
}
