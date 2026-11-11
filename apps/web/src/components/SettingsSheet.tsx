/**
 * SettingsSheet (M1.6, 2026-05-06), opened from Telegram's gear button or
 * the browser header. The page's own actions come first (M1.12), then the
 * person's own things: profile, workspace, store, language, the stall's
 * language and About. Organisation settings stay in Admin, so this stays
 * "my preferences" (M1.6 #3).
 *
 * Review COREWEB1-24 (2026-11-12): the profile and About were grey boxes
 * of hand-written rows, the read-only name looked like an input, and the
 * "Create a new workspace" button sat inside the workspace radiogroup.
 * They are Cards of DetailRows (UI-13), the button follows the choice,
 * and one workspace is no choice: the section shows when there is a
 * second one to switch to or a platform admin may create one (UI-10;
 * About names the workspace). COREWEB1-21: the language choices are
 * components/LanguagePicker.tsx, shared with the language sheet.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  DetailRow,
  PickerGroup,
  PickerRow,
  SectionLabel,
  Sheet,
  useToast,
} from '@compass/ui';
import { runningBuildId } from '../lib/build';
import { formatList } from '../lib/listFormat';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { requestTabChange, type Tab } from '../stores/navStore';
import { waitingWriteCount } from '../lib/outbox/engine';
import { isInTelegram } from '../lib/telegram';
import { useI18n, useRoleLabels } from '../hooks/useI18n';
import { useErrToast } from '../hooks/useErrToast';
import type { PageMenuRegistration } from './PageMenuContext';
import { StorePickerSection } from './StoreSwitcher';
import { useCanSeeStorePicker } from '../hooks/useStoreContext';
import { requestStoreChange } from '../lib/storeContext';
import { confirmNative } from '../lib/confirm';
import { CreateWorkspaceForm } from './CreateWorkspace';
import { BLOCKS_NAVIGATION } from '../hooks/useAppMutating';
import { LanguagePicker, SecondaryLanguagePicker } from './LanguagePicker';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * M1.12: the open page's own actions (the run's "Undo start purchase",
   * "Cancel run"), at the top so whoever came for one does not scroll
   * past the profile and the languages to reach it.
   */
  pageMenu?: PageMenuRegistration | null;
}

/**
 * DX-SHL-3 (2026-11-01): switching workspace replaces every page, so it
 * asks first and then lets the pages' unsaved-draft guards (daily close)
 * veto it, like a tab or store change does. After the switch the shell
 * lands on the order tab with the new workspace's first store, which is
 * what the guards are asked about. Exported for tests.
 */
export async function mayLeaveWorkspace(deps: {
  confirm: () => Promise<boolean>;
  requestTabChange: (next: Tab) => Promise<boolean>;
  requestStoreChange: (next: null) => Promise<boolean>;
}): Promise<boolean> {
  if (!(await deps.confirm())) return false;
  if (!(await deps.requestTabChange('order'))) return false;
  return deps.requestStoreChange(null);
}

export function SettingsSheet({ open, onOpenChange, pageMenu }: Props) {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const session = useAuthStore((s) => s.session);
  const setSession = useAuthStore((s) => s.setSession);
  const toast = useToast();
  // M1.21: server error keys (`auth.errors.displayNameTaken`) in words.
  const errToast = useErrToast();

  // The build for the About row, so a bug report can say which one it
  // is (review COREWEB1-12: always "dev" before).
  const buildId = runningBuildId() ?? 'dev';

  const switchOrganization = trpc.auth.switchOrganization.useMutation({
    meta: BLOCKS_NAVIGATION,
    onSuccess: (data) => {
      // The new session drops the old workspace's cached data and
      // navigation (App's useQueryCachePersistence, COREWEB1-04).
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      toast.success(i18n.t('workspace.switched'));
      onOpenChange(false);
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  // AUTH-16: reopening the sheet starts from the workspace list again.
  useEffect(() => {
    if (!open) setCreatingWorkspace(false);
  }, [open]);

  // M3.5: org.admin holders can switch store context here; since the
  // 2026-10-21 audit (CA-22) so can members assigned to ≥2 stores.
  const canSeeStorePicker = useCanSeeStorePicker();

  const memberships = session?.memberships ?? [];
  const canCreateWorkspace = session?.isPlatformAdmin ?? false;
  // AUTH-15 (2026-10-30): role names, once each; they were raw slugs, one
  // per binding ("super_admin, staff, cashier, staff").
  const roleNames = [...new Set(session?.roleSlugs ?? [])].map((slug) => roleText.name({ slug }));

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={i18n.t('settings.title')}>
      <div className="flex flex-col gap-4 py-3">
        {/* ── Page actions (contextual, M1.12) ─────────────── */}
        {pageMenu && pageMenu.actions.length > 0 ? (
          <section>
            <SectionLabel as="h3" padded={false} className="mb-2">
              {pageMenu.title}
            </SectionLabel>
            <div className="flex flex-col gap-2">
              {pageMenu.actions.map((a, i) => (
                <Button
                  key={`${a.label}-${i}`}
                  block
                  variant={a.variant ?? 'pearl'}
                  disabled={a.disabled}
                  onClick={() => {
                    onOpenChange(false);
                    a.onClick();
                  }}
                >
                  <span className="flex flex-col items-start text-left">
                    <span>{a.label}</span>
                    {a.hint ? (
                      <span className="mt-0.5 text-old-label opacity-80">{a.hint}</span>
                    ) : null}
                  </span>
                </Button>
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Profile ─────────────────────────────────────── */}
        <section>
          <SectionLabel as="h3" padded={false} className="mb-2">
            {i18n.t('settings.profile.title')}
          </SectionLabel>
          {/* AUTH-22 (2026-10-30): the name is always locked here (anyone
              whose name is not yet confirmed is held at onboarding before
              they can open settings), so it reads as text, not a field. */}
          <Card className="flex flex-col gap-2 px-4 py-3">
            <DetailRow
              label={i18n.t('settings.profile.displayName')}
              value={session?.user.displayName ?? '—'}
            />
            {session?.user.tgUsername ? (
              <DetailRow
                label={i18n.t('settings.profile.username')}
                value={`@${session.user.tgUsername}`}
              />
            ) : null}
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('settings.profile.lockedHint')}
            </p>
          </Card>
        </section>

        {/* ── Workspace switcher / new tenant ──────────────── */}
        {memberships.length > 1 || canCreateWorkspace ? (
          <section>
            <SectionLabel as="h3" padded={false} className="mb-2">
              {i18n.t('workspace.title')}
            </SectionLabel>
            {creatingWorkspace ? (
              <div className="flex flex-col gap-2">
                <CreateWorkspaceForm onCreated={() => setCreatingWorkspace(false)} />
                {/* AUTH-16 (2026-10-30): the form had no way back. */}
                <Button block variant="ghost" onClick={() => setCreatingWorkspace(false)}>
                  {i18n.t('common.cancel')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {memberships.length > 1 ? (
                  <PickerGroup label={i18n.t('workspace.title')}>
                    {memberships.map((membership) => {
                      const selected = membership.orgId === session?.member.orgId;
                      return (
                        <PickerRow
                          key={membership.orgId}
                          label={membership.orgName}
                          hint={selected ? i18n.t('workspace.current') : undefined}
                          selected={selected}
                          disabled={switchOrganization.isPending}
                          onClick={() => {
                            if (selected) return;
                            void mayLeaveWorkspace({
                              // COREWEB2-03: writes still waiting to be sent
                              // stay with this workspace; say so before
                              // leaving it.
                              confirm: async () => {
                                const waiting = await waitingWriteCount();
                                return confirmNative(
                                  waiting > 0
                                    ? i18n.t('workspace.switchConfirmPending', {
                                        name: membership.orgName,
                                        n: waiting,
                                      })
                                    : i18n.t('workspace.switchConfirm', {
                                        name: membership.orgName,
                                      }),
                                );
                              },
                              requestTabChange,
                              requestStoreChange,
                            }).then((ok) => {
                              if (ok) switchOrganization.mutate({ orgId: membership.orgId });
                            });
                          }}
                        />
                      );
                    })}
                  </PickerGroup>
                ) : null}
                {canCreateWorkspace ? (
                  <Button block variant="pearl" onClick={() => setCreatingWorkspace(true)}>
                    {i18n.t('workspace.create.action')}
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {/* ── Store picker (M3.5, org.admin only) ──────────── */}
        {canSeeStorePicker ? <StorePickerSection onClose={() => onOpenChange(false)} /> : null}

        {/* ── Language ────────────────────────────────────── */}
        <section>
          <SectionLabel as="h3" padded={false} className="mb-2">
            {i18n.t('settings.language.title')}
          </SectionLabel>
          <LanguagePicker />
        </section>

        {/* ── The stall's language (M3.45) ─────────────────── */}
        <section>
          <SectionLabel as="h3" padded={false} className="mb-2">
            {i18n.t('settings.secondaryLanguage.title')}
          </SectionLabel>
          <div className="mb-2 text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('settings.secondaryLanguage.hint')}
          </div>
          <SecondaryLanguagePicker />
        </section>

        {/* ── About ───────────────────────────────────────── */}
        <section>
          <SectionLabel as="h3" padded={false} className="mb-2">
            {i18n.t('settings.about.title')}
          </SectionLabel>
          <Card className="flex flex-col gap-2 px-4 py-3">
            <DetailRow
              label={i18n.t('settings.about.workspace')}
              value={session?.member.orgName ?? '—'}
            />
            {roleNames.length > 0 ? (
              <DetailRow
                label={i18n.t('settings.about.role')}
                value={formatList(roleNames, i18n.locale)}
              />
            ) : null}
            {/* UI-14: the build is a code, so monospace. */}
            <DetailRow
              label={i18n.t('settings.about.build')}
              value={<span className="font-mono">{buildId}</span>}
            />
          </Card>
        </section>
        {/* Local development in a plain browser: back to the persona picker
            (there is no sign-out in production, where Telegram is the login). */}
        {import.meta.env.DEV && !isInTelegram() ? (
          <Button
            block
            variant="secondary"
            onClick={() => {
              useAuthStore.getState().clear();
              onOpenChange(false);
            }}
          >
            {i18n.t('dev.switchPersona')}
          </Button>
        ) : null}
      </div>
      {/* UIUX-B1: trailing Cancel deleted — the sheet dismisses via
          scrim-tap and Telegram back, and Settings has nothing to
          "cancel" (every change saves immediately). */}
    </Sheet>
  );
}
