/**
 * Development builds: sign in as any member of the local database.
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx.
 */
import { Banner, Button, Spinner } from '@compass/ui';
import { useI18n, useRoleLabels } from '../../hooks/useI18n';

export interface DevPersona {
  memberId: string;
  displayName: string;
  orgName: string;
  tgUserId: string | null;
  roleSlugs: string[];
  storeNames: string[];
  isAdmin: boolean;
  maxRank: number;
  permissionCount: number;
}

export function DevPersonaPicker({
  personas,
  loading,
  error,
  pending,
  onSelect,
  onAutoLogin,
}: {
  personas: readonly DevPersona[];
  loading: boolean;
  error: string | null;
  pending: boolean;
  onSelect: (memberId: string) => void;
  onAutoLogin: () => void;
}) {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  return (
    <section className="mt-2 flex w-full max-w-sm flex-col gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 text-left ring-hairline">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-old-h3 font-semibold text-[var(--c-fg)]">
            {i18n.t('dev.persona.title')}
          </div>
          <p className="mt-1 text-old-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('dev.persona.body')}
          </p>
          <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('dev.persona.urlHint', { param: '?devAs=…', example: '?devAs=aziz' })}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          loading={pending}
          onClick={onAutoLogin}
        >
          {i18n.t('dev.persona.auto')}
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-4 text-[var(--c-fg-muted)]">
          <Spinner size={22} />
        </div>
      ) : error ? (
        <Banner tone="danger" title={i18n.t('dev.persona.loadFailed')}>
          {error}
        </Banner>
      ) : personas.length === 0 ? (
        <Banner tone="warn" title={i18n.t('dev.persona.emptyTitle')}>
          {i18n.t('dev.persona.emptyBody')}
        </Banner>
      ) : (
        <div className="grid max-h-[52vh] grid-cols-[minmax(0,1fr)] gap-2 overflow-y-auto pr-1">
          {personas.map((persona) => {
            const stores =
              persona.storeNames.length > 0
                ? persona.storeNames.join(', ')
                : i18n.t('dev.persona.noStores');
            const roles =
              persona.roleSlugs.length > 0
                ? persona.roleSlugs.map((slug) => roleText.name({ slug })).join(', ')
                : i18n.t('dev.persona.noRoles');
            return (
              <button
                key={persona.memberId}
                type="button"
                disabled={pending}
                onClick={() => onSelect(persona.memberId)}
                className="press w-full rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 text-left ring-hairline disabled:opacity-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-old-body font-semibold text-[var(--c-fg)]">
                    {persona.displayName}
                  </div>
                  <div className="shrink-0 rounded-full bg-[var(--c-surface)] px-2 py-0.5 text-old-label font-semibold text-[var(--c-fg-muted)] ring-hairline">
                    {persona.isAdmin ? roleText.name({ slug: 'admin' }) : `R${persona.maxRank}`}
                  </div>
                </div>
                <div className="mt-1 truncate text-old-body-sm text-[var(--c-fg-muted)]">
                  {persona.orgName} · {roles}
                </div>
                <div className="mt-0.5 truncate text-old-label text-[var(--c-fg-muted)]">
                  {stores} · {i18n.t('people.permissionCount', { n: persona.permissionCount })}
                  {persona.tgUserId ? ` · TG ${persona.tgUserId}` : ''}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
