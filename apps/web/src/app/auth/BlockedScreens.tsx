/**
 * Signed in, but nothing to open yet: no store, or no role.
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx.
 */
import { useState } from 'react';
import { Button, useToast } from '@compass/ui';
import { useAuthStore } from '../../stores/authStore';
import { noteSessionCleared } from '../../lib/trpc';
import { getTg } from '../../lib/telegram';
import { useI18n } from '../../hooks/useI18n';
import { useRefreshSession } from '../../hooks/useRefreshSession';
import { accessBlock } from '../../lib/authAccess';
import { TelegramIdChip } from './TelegramIdChip';

/** Confirmed name but no store assigned yet — wait for admin. */
export function NoStoreScreen() {
  const i18n = useI18n();
  return <BlockedScreen title={i18n.t('auth.noStore.title')} body={i18n.t('auth.noStore.body')} />;
}

export function NoAccessScreen() {
  const i18n = useI18n();
  return (
    <BlockedScreen title={i18n.t('auth.noAccess.title')} body={i18n.t('auth.noAccess.body')} />
  );
}

/**
 * CMP-SHL-1 (2026-10-31): "no role" and "no store" were dead ends — no way
 * to check again once the administrator had acted, no way out, and no sign
 * of who was signed in. Now: who (name, Telegram id to send to the
 * administrator), Retry (re-reads the session; the app opens as soon as
 * access is there) and a way out — inside Telegram that closes the Mini
 * App, since the Telegram account is the identity; in a browser it signs
 * out. Who to ask follows D24: roles, members and stores → administrator.
 */
function BlockedScreen({ title, body }: { title: string; body: string }) {
  const i18n = useI18n();
  const toast = useToast();
  const session = useAuthStore((s) => s.session);
  const clear = useAuthStore((s) => s.clear);
  const refreshSession = useRefreshSession();
  const [checking, setChecking] = useState(false);
  const inTelegram = Boolean(getTg()?.initData);
  const tgUserId =
    session?.user.tgUserId ?? (inTelegram ? String(getTg()?.initDataUnsafe?.user?.id ?? '') : '');
  const name = session?.user.displayName;
  return (
    <div className="flex h-full flex-col px-6 pt-12 pb-8">
      <div className="flex flex-1 flex-col items-center gap-4 text-center">
        <h1 className="text-old-h1 font-semibold">{title}</h1>
        <p className="text-old-body text-[var(--c-fg-muted)]">{body}</p>
        {name && !name.startsWith('tg:') ? (
          <p className="text-old-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('auth.blocked.signedInAs', { name })}
          </p>
        ) : null}
        {tgUserId ? (
          <>
            <p className="text-old-body-sm text-[var(--c-fg-muted)]">
              {i18n.t('auth.shareThisId')}
            </p>
            <TelegramIdChip id={tgUserId} />
          </>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          block
          size="lg"
          loading={checking}
          onClick={() => {
            setChecking(true);
            void refreshSession().then((applied) => {
              setChecking(false);
              // Granted: the gate re-renders into the app on its own.
              const now = useAuthStore.getState().session;
              if (!applied) toast.error(i18n.t('common.networkError'));
              else if (now && accessBlock(now)) toast.info(i18n.t('auth.blocked.stillBlocked'));
            });
          }}
        >
          {i18n.t('common.retry')}
        </Button>
        <Button
          block
          size="lg"
          variant="secondary"
          onClick={() => {
            const tg = inTelegram ? getTg() : null;
            if (tg) {
              tg.close();
              return;
            }
            noteSessionCleared('blocked-sign-out');
            clear();
          }}
        >
          {i18n.t(inTelegram ? 'auth.blocked.close' : 'auth.blocked.signOut')}
        </Button>
      </div>
    </div>
  );
}
