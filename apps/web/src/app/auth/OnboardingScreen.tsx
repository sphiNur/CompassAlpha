import { useState } from 'react';
import { Banner, Button, Field, Input } from '@compass/ui';
import { useAuthStore } from '../../stores/authStore';
import { trpc } from '../../lib/trpc';
import { haptic } from '../../lib/telegram';
import { useI18n } from '../../hooks/useI18n';
import { useTranslateError } from '../../hooks/useErrToast';

/**
 * One-shot name-confirmation screen. Pre-fills the user's Telegram name
 * (or admin-set placeholder), lets them change it once, then locks it.
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx.
 */
export function OnboardingScreen() {
  const session = useAuthStore((s) => s.session);
  const setSession = useAuthStore((s) => s.setSession);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const i18n = useI18n();
  const initial =
    session?.user.displayName && !session.user.displayName.startsWith('tg:')
      ? session.user.displayName
      : '';
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const translateError = useTranslateError();

  const complete = trpc.auth.completeOnboarding.useMutation({
    onSuccess(updatedSession) {
      haptic('success');
      if (accessToken && refreshToken) {
        setSession({ accessToken, refreshToken, session: updatedSession });
      }
    },
    onError(err) {
      haptic('error');
      // 2026-10-21 audit CA-48: server keys (e.g. auth.errors.nameLocked)
      // were shown raw.
      setError(translateError(err, 'auth.onboarding.failed'));
    },
  });

  // DX-SHL-6 (2026-11-01): a real form, so Enter (the keyboard's "done")
  // submits, and the label is tied to the field (it was read out as the
  // placeholder only).
  const canSubmit = name.trim().length >= 1 && !complete.isPending;
  return (
    <form
      className="flex h-full flex-col px-6 pt-12 pb-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) complete.mutate({ displayName: name.trim() });
      }}
    >
      <div className="flex-1 flex flex-col justify-center gap-4">
        <h1 className="text-old-h1 font-semibold leading-tight text-[var(--c-fg)]">
          {i18n.t('auth.onboarding.title')}
        </h1>
        <p className="text-old-body leading-relaxed text-[var(--c-fg-muted)]">
          {i18n.t('auth.onboarding.body')}
        </p>
        <Field label={i18n.t('auth.onboarding.nameLabel')}>
          <Input
            enterKeyHint="done"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder={i18n.t('auth.onboarding.namePlaceholder')}
            autoFocus
          />
        </Field>
        {error ? (
          <Banner tone="danger" title={i18n.t('auth.onboarding.failed')}>
            {error}
          </Banner>
        ) : null}
      </div>
      <Button
        block
        size="lg"
        type="submit"
        loading={complete.isPending}
        disabled={name.trim().length < 1}
      >
        {i18n.t('auth.onboarding.continue')}
      </Button>
    </form>
  );
}
