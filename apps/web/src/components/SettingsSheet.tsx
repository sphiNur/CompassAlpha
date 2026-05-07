/**
 * SettingsSheet (M1.6, 2026-05-06).
 *
 * Replaces the previous "language picker only" SettingsButton handler
 * with a proper settings hub:
 *
 *   👤 Profile     — display name + Telegram handle (read-only when
 *                    `displayNameLocked` is true; the lock is the
 *                    anti-impersonation guarantee from auth.ts that we
 *                    deliberately preserve here).
 *   🌐 Language    — inline 4-locale picker (same options as the old
 *                    LanguageSheet; persists via `auth.setLocale`).
 *   ℹ️ About       — workspace name, role(s), client build sha + (if
 *                    available) server commit. No actions, just so the
 *                    user can read off what they're running before
 *                    filing a bug.
 *
 * Architectural note (the user asked me to decide for them, M1.6 #3):
 * Settings is intentionally limited to *self-things*. The temptation
 * was to move admin actions out of AdminPage and into Settings to
 * "lighten the admin load" — I refused. Settings = "my preferences."
 * Admin-of-org things stay in Admin so the mental model stays clean.
 */
import { useState } from 'react';
import { Sheet, Button, Field, Input } from '@compass/ui';
import { useToast } from '@compass/ui';
import type { Locale } from '@compass/i18n';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import type { PageMenuRegistration } from '../app/PageMenuContext';

interface LangOption {
  code: Locale;
  label: string;
  region: string;
}

const LANGS: LangOption[] = [
  { code: 'uz', label: "O'zbekcha", region: 'UZ' },
  { code: 'ru', label: 'Русский', region: 'RU' },
  { code: 'en', label: 'English', region: 'EN' },
  { code: 'zh', label: '中文', region: 'ZH' },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * M1.12: optional contextual section for the currently-active page
   * (e.g., RunPage's "Undo start purchase" / "Cancel run"). Lives at
   * the very top of the sheet so frequent users don't have to scroll
   * past Profile + Language to reach the destructive action they
   * came in for.
   */
  pageMenu?: PageMenuRegistration | null;
}

export function SettingsSheet({ open, onOpenChange, pageMenu }: Props) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const patchSession = useAuthStore((s) => s.patchSession);
  const toast = useToast();

  // Build hash for the About row. Vite injects this at build time so
  // we can read whatever HEAD was at deploy. Falls back to a string
  // marker for local dev.
  const buildId =
    (typeof __COMPASS_BUILD_SHA__ === 'string' ? __COMPASS_BUILD_SHA__ : null) ?? 'dev';

  const setLocale = trpc.auth.setLocale.useMutation({
    onSuccess: (next) => {
      patchSession(next as never);
    },
    onError: (err) => toast.error(err.message),
  });

  // Optional self-rename: the server `auth.completeOnboarding` is the
  // sanctioned path and only works when the name isn't already locked.
  // For users whose name IS locked, the form is read-only with the
  // "ask your admin" hint — preserves the impersonation safeguard.
  const completeOnboarding = trpc.auth.completeOnboarding.useMutation({
    onSuccess: (next) => {
      patchSession(next as never);
      toast.success(i18n.t('common.saved') as string);
    },
    onError: (err) => toast.error(err.message),
  });

  const [draftName, setDraftName] = useState<string>(() => session?.user.displayName ?? '');
  const nameLocked = !!session?.user.displayNameLocked;
  const nameDirty = !nameLocked && draftName.trim() !== (session?.user.displayName ?? '');

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={i18n.t('settings.title')}
    >
      <div className="flex flex-col gap-4 py-3">
        {/* ── Page actions (contextual, M1.12) ─────────────── */}
        {pageMenu && pageMenu.actions.length > 0 ? (
          <section>
            <h3 className="mb-2 text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
              {pageMenu.title}
            </h3>
            <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
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
                      <span className="mt-0.5 text-meta opacity-80">{a.hint}</span>
                    ) : null}
                  </span>
                </Button>
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Profile ─────────────────────────────────────── */}
        <section>
          <h3 className="mb-2 text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
            👤 {i18n.t('settings.profile.title')}
          </h3>
          <div className="flex flex-col gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
            <Field label={i18n.t('settings.profile.displayName')}>
              {nameLocked ? (
                <>
                  <div className="rounded-[var(--r-pill)] bg-[var(--c-surface)] px-4 py-2 text-body ring-hairline">
                    {session?.user.displayName ?? '—'}
                  </div>
                  <p className="mt-1 text-meta text-[var(--c-fg-muted)]">
                    {i18n.t('settings.profile.lockedHint')}
                  </p>
                </>
              ) : (
                <div className="flex gap-2">
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    maxLength={200}
                  />
                  <Button
                    size="sm"
                    loading={completeOnboarding.isPending}
                    disabled={!nameDirty || !draftName.trim()}
                    onClick={() =>
                      completeOnboarding.mutate({ displayName: draftName.trim() })
                    }
                  >
                    {i18n.t('common.save')}
                  </Button>
                </div>
              )}
            </Field>
            {session?.user.tgUsername ? (
              <Field label={i18n.t('settings.profile.username')}>
                <div className="rounded-[var(--r-pill)] bg-[var(--c-surface)] px-4 py-2 text-body ring-hairline">
                  @{session.user.tgUsername}
                </div>
              </Field>
            ) : null}
          </div>
        </section>

        {/* ── Language ────────────────────────────────────── */}
        <section>
          <h3 className="mb-2 text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
            🌐 {i18n.t('settings.language.title')}
          </h3>
          <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
            {LANGS.map((lang) => {
              const selected = (session?.user.locale ?? 'en') === lang.code;
              return (
                <button
                  key={lang.code}
                  type="button"
                  disabled={setLocale.isPending}
                  onClick={() => {
                    if (!selected) setLocale.mutate({ locale: lang.code });
                  }}
                  className={
                    'flex items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left ' +
                    (selected
                      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                      : 'bg-[var(--c-surface)] text-[var(--c-fg)] active:opacity-80')
                  }
                >
                  <div className="min-w-0">
                    <div className="text-h3 font-semibold">{lang.label}</div>
                    <div
                      className={
                        'mt-0.5 text-meta ' +
                        (selected ? 'opacity-80' : 'text-[var(--c-fg-muted)]')
                      }
                    >
                      {lang.region}
                    </div>
                  </div>
                  {selected ? <span aria-hidden>✓</span> : null}
                </button>
              );
            })}
          </div>
        </section>

        {/* ── About ───────────────────────────────────────── */}
        <section>
          <h3 className="mb-2 text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
            ℹ️ {i18n.t('settings.about.title')}
          </h3>
          <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
            <div className="flex items-baseline justify-between text-body-sm">
              <span className="text-[var(--c-fg-muted)]">
                {i18n.t('settings.about.workspace')}
              </span>
              <span className="font-medium text-[var(--c-fg)]">
                {session?.member.orgName ?? '—'}
              </span>
            </div>
            {(session?.roleSlugs ?? []).length > 0 ? (
              <div className="flex items-baseline justify-between text-body-sm">
                <span className="text-[var(--c-fg-muted)]">
                  {i18n.t('settings.about.role')}
                </span>
                <span className="font-medium text-[var(--c-fg)]">
                  {(session?.roleSlugs ?? []).join(', ')}
                </span>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between text-body-sm">
              <span className="text-[var(--c-fg-muted)]">
                {i18n.t('settings.about.build')}
              </span>
              <span className="font-mono text-meta text-[var(--c-fg-muted)]">
                {buildId}
              </span>
            </div>
          </div>
        </section>
      </div>
      <div className="px-4 pb-2">
        <Button block variant="pearl" onClick={() => onOpenChange(false)}>
          {i18n.t('common.cancel')}
        </Button>
      </div>
    </Sheet>
  );
}

declare const __COMPASS_BUILD_SHA__: string;
