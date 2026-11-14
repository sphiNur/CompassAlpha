import { useState } from 'react';
import { Button, Field, Input } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { initialDevBrowserTgUserId } from './launch';

/**
 * Sign in outside Telegram with a Telegram ID and an access code (test and
 * staging servers; production turns this login off).
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx. COREWEB1-18: the
 * Telegram ID label was English in every language.
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
  const [showCode, setShowCode] = useState(false);
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
      <Field label={i18n.t('dev.browserLogin.tgId')}>
        {/* Review MWA-12 (modern-web-guidance: autofill-sign-in-form): a
            stable name, required, and no autocorrect, capitals or spell
            check on an identifier, so a password manager fills and saves
            the pair. Submit still waits for both (unchanged). */}
        <Input
          name="tgUserId"
          required
          inputMode="numeric"
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          value={tgUserId}
          onChange={(e) => setTgUserId(e.target.value)}
          autoFocus={!tgUserId}
          placeholder={i18n.t('dev.browserLogin.tgIdPlaceholder', { example: '123456789' })}
        />
      </Field>
      <Field label={i18n.t('dev.browserLogin.accessCode')}>
        {/* Review MWA-13 (V11, modern-web-guidance: autofill-sign-in-form,
            forms): "provide an accessible toggle <button type="button">
            with aria-pressed allowing users to unmask password input". */}
        <div className="relative">
          <Input
            type={showCode ? 'text' : 'password'}
            name="accessCode"
            required
            enterKeyHint="go"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            autoFocus={!!tgUserId}
            placeholder={i18n.t('dev.browserLogin.accessCodePlaceholder')}
            className="pr-12"
          />
          <button
            type="button"
            aria-pressed={showCode}
            aria-label={i18n.t('dev.browserLogin.showCode')}
            onClick={() => setShowCode((v) => !v)}
            className="press absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-[var(--r-pill)] text-[var(--c-fg-muted)]"
          >
            <EyeIcon open={showCode} />
          </button>
        </div>
      </Field>
      <Button block type="submit" loading={pending} disabled={!tgUserId.trim() || !accessCode}>
        {i18n.t('dev.browserLogin.submit')}
      </Button>
    </form>
  );
}

/** MWA-13: an eye, struck through while the code is hidden. */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M1.75 10S4.75 4.25 10 4.25 18.25 10 18.25 10 15.25 15.75 10 15.75 1.75 10 1.75 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      {open ? null : (
        <path d="M3 17 17 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}
