import { useState } from 'react';
import { Button, Field, Input } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { initialDevBrowserTgUserId } from './launch';

/**
 * Sign in outside Telegram with a Telegram ID and an access code (test and
 * staging servers; production turns this login off).
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx.
 */
export function BrowserLoginForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (tgUserId: string, accessCode: string) => void;
}) {
  const i18n = useI18n();
  const [tgUserId, setTgUserId] = useState(initialDevBrowserTgUserId);
  const [accessCode, setAccessCode] = useState('');
  return (
    <form
      className="mt-2 flex w-full max-w-sm flex-col gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 text-left ring-hairline"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(tgUserId.trim(), accessCode);
      }}
    >
      <div className="text-center">
        <div className="text-old-h3 font-semibold text-[var(--c-fg)]">
          {i18n.t('dev.browserLogin.title')}
        </div>
        <p className="mt-1 text-old-body-sm text-[var(--c-fg-muted)]">
          {i18n.t('dev.browserLogin.body')}
        </p>
      </div>
      <Field label="Telegram ID">
        <Input
          inputMode="numeric"
          autoComplete="username"
          value={tgUserId}
          onChange={(e) => setTgUserId(e.target.value)}
          autoFocus={!tgUserId}
          placeholder={i18n.t('dev.browserLogin.tgIdPlaceholder', { example: '123456789' })}
        />
      </Field>
      <Field label={i18n.t('dev.browserLogin.accessCode')}>
        <Input
          type="password"
          autoComplete="current-password"
          value={accessCode}
          onChange={(e) => setAccessCode(e.target.value)}
          autoFocus={!!tgUserId}
          placeholder={i18n.t('dev.browserLogin.accessCodePlaceholder')}
        />
      </Field>
      <Button block type="submit" loading={pending} disabled={!tgUserId.trim() || !accessCode}>
        {i18n.t('dev.browserLogin.submit')}
      </Button>
    </form>
  );
}
