/**
 * The language sheet: the interface language on its own, for where the
 * settings sheet is not the way in. Choosing one closes it; Cancel and a
 * tap outside leave it (ConfirmSheet rules, 2026-05-04). The choice
 * itself is the settings sheet's (components/LanguagePicker.tsx).
 */
import { Button, Sheet } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import { LanguagePicker } from './LanguagePicker';

interface LanguageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LanguageSheet({ open, onOpenChange }: LanguageSheetProps) {
  const i18n = useI18n();
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={i18n.t('settings.language.title')}
      description={i18n.t('settings.language.subtitle')}
    >
      <div className="py-3">
        <LanguagePicker onPicked={() => onOpenChange(false)} />
      </div>
      <div className="px-4 pb-2">
        <Button block variant="pearl" onClick={() => onOpenChange(false)}>
          {i18n.t('common.cancel')}
        </Button>
      </div>
    </Sheet>
  );
}
