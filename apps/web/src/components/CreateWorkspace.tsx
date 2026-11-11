import { useRef, useState } from 'react';
import { Button, Field, Input, SectionLabel, useToast } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import { trpc } from '../lib/trpc';
import { useErrToast } from '../lib/errToast';
import { useAuthStore } from '../stores/authStore';
import { BLOCKS_NAVIGATION } from '../hooks/useAppMutating';

/**
 * Self-service tenant creation, from Settings → Workspace (SettingsSheet).
 */
export function CreateWorkspaceForm({ onCreated }: { onCreated?: () => void }) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const setSession = useAuthStore((s) => s.setSession);
  const [name, setName] = useState('');
  // AUTH-1: `isPending` only disables the button after a re-render, so a
  // fast double tap created two workspaces with the same name. Lock in
  // the click handler itself.
  const submitting = useRef(false);

  const create = trpc.auth.createOrganization.useMutation({
    meta: BLOCKS_NAVIGATION,
    onSuccess(data) {
      // The new session drops the previous workspace's cached data and
      // navigation (App's useQueryCachePersistence, COREWEB1-04).
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      toast.success(i18n.t('workspace.create.created'));
      setName('');
      onCreated?.();
    },
    onError: errToast('workspace.create.failed'),
    onSettled() {
      submitting.current = false;
    },
  });

  const canSubmit = name.trim().length >= 2 && !create.isPending;
  return (
    <section className="flex flex-col gap-2 text-left">
      <SectionLabel as="h3" padded={false}>
        {i18n.t('workspace.create.title')}
      </SectionLabel>
      <p className="text-old-body-sm text-[var(--c-fg-muted)]">{i18n.t('workspace.create.body')}</p>
      <Field label={i18n.t('workspace.create.name')}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 200))}
          maxLength={200}
          placeholder={i18n.t('workspace.create.namePlaceholder')}
        />
      </Field>
      <Button
        block
        loading={create.isPending}
        disabled={!canSubmit}
        onClick={() => {
          if (submitting.current) return;
          submitting.current = true;
          create.mutate({
            name: name.trim(),
            locale: i18n.locale,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
        }}
      >
        {i18n.t('workspace.create.submit')}
      </Button>
    </section>
  );
}
