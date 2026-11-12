import { useState } from 'react';
import { Field, Input } from '@compass/ui';
import { useI18n } from '../../../../hooks/useI18n';
import { readRank } from '../../../../lib/adminFields';

/**
 * DX-ADM-4: the rank field keeps what is typed and says, once the person
 * leaves it, that it wants a whole number in range — no clamping while
 * typing.
 */
export function RankField({
  text,
  onText,
  min = 1,
  max,
  hint,
}: {
  text: string;
  onText: (text: string) => void;
  min?: number;
  max: number;
  hint?: string;
}) {
  const i18n = useI18n();
  const [touched, setTouched] = useState(false);
  const bad = touched && !readRank(text, max, min).ok;
  return (
    <Field
      label={i18n.t('people.rankField', { min, max })}
      required
      hint={hint}
      error={bad ? i18n.t('people.rankInvalid', { min, max }) : null}
    >
      <Input
        value={text}
        onChange={(e) => onText(e.target.value)}
        onBlur={() => setTouched(true)}
        inputMode="numeric"
        maxLength={3}
      />
    </Field>
  );
}
