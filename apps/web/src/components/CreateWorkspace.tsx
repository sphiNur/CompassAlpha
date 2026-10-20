import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, SectionLabel, useToast } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import { getTg } from '../hooks/useTelegram';
import { trpc } from '../lib/trpc';
import { useErrToast } from '../lib/errToast';
import { useAuthStore } from '../stores/authStore';

/**
 * Self-service tenant creation. Used both from the no-membership login
 * screen and from Settings → Workspace.
 */
export function CreateWorkspaceForm({ onCreated }: { onCreated?: () => void }) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const setSession = useAuthStore((s) => s.setSession);
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  const create = trpc.auth.createOrganization.useMutation({
    onSuccess(data) {
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      // Cached queries are keyed by route, not by tenant. Drop them so
      // no row from the previous workspace can flash after the switch.
      queryClient.clear();
      toast.success(i18n.t('workspace.create.created'));
      setName('');
      onCreated?.();
    },
    onError: errToast('workspace.create.failed'),
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
          const initData = getTg()?.initData;
          if (!initData) {
            toast.error(i18n.t('auth.errors.noInitData'));
            return;
          }
          create.mutate({
            initData,
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
