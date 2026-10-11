import { lazy, Suspense, useState } from 'react';
import { cn, Sheet, StatusChip } from '@compass/ui/kit';
import { PAGE_SIZE } from '../../config/timings';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useDateFormat, useI18n } from '../../hooks/useI18n';
import { ChevronIcon, ClockIcon } from '../icons';

// The developer console: for whoever looks after the installation.
const DebugPage = lazy(() =>
  import('../../pages/DebugPage').then((m) => ({ default: m.DebugPage })),
);

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70';
const pick = (on: boolean) =>
  cn(CAPSULE, on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');

function Nothing({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-lg">
      <span
        aria-hidden
        className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
      >
        <ClockIcon />
      </span>
      <span className="min-w-0">
        <span className="block text-label text-secondary">{title}</span>
        {hint ? <span className="block text-small text-secondary">{hint}</span> : null}
      </span>
    </div>
  );
}

/**
 * A sentence for something the app has a name for, else the name as
 * the server wrote it: a log must never hide an entry it cannot word.
 */
function useSaid() {
  const i18n = useI18n();
  return (key: string, fallback: string): string => {
    const said = i18n.t(key as Parameters<typeof i18n.t>[0]) as string;
    return said === key ? fallback : said;
  };
}

/**
 * How the organisation stands, and what has been happening in it: six
 * figures, then the latest things people did, each as a sentence with
 * who and when. They were shown as the system's own event names
 * (`order.Submitted`) with a sequence number.
 */
export function ActivityScreen() {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const said = useSaid();
  const session = useAuthStore((s) => s.session);
  const overview = trpc.admin.overview.useQuery();
  const events = trpc.admin.recentEvents.useQuery({ limit: PAGE_SIZE.feed });
  const [debug, setDebug] = useState(false);

  const figures = overview.data
    ? ([
        ['pendingApprovals', overview.data.pendingApprovals],
        ['ordersThisWeek', overview.data.ordersThisWeek],
        ['totalRuns', overview.data.runCount],
        ['activeSkus', overview.data.skuCount],
        ['stores', overview.data.storeCount],
        ['members', overview.data.memberCount],
      ] as const)
    : [];

  return (
    <div className="flex flex-col gap-xl px-page">
      {overview.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : overview.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-lg gap-y-xl rounded-lg bg-surface p-xl">
          {figures.map(([key, n]) => (
            <div key={key} data-testid="activity-figure" className="flex flex-col gap-xs">
              <dt className="text-small text-secondary">{i18n.t(`admin.tile.${key}`)}</dt>
              <dd
                className={cn(
                  'text-h1 tabular-nums',
                  // Only what is waiting on someone is coloured.
                  key === 'pendingApprovals' && n > 0 ? 'text-warning-ink' : 'text-ink',
                )}
              >
                {n}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <section className="flex flex-col gap-sm">
        <h2 className="text-h2 text-ink">{i18n.t('logs.recent')}</h2>
        {events.isPending ? (
          <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
        ) : events.isError ? (
          <p className="text-body text-danger">{i18n.t('common.error')}</p>
        ) : events.data.length === 0 ? (
          <Nothing
            title={i18n.t('ops.activity.emptyTitle') as string}
            hint={i18n.t('ops.activity.emptyBody') as string}
          />
        ) : (
          <ul className="flex flex-col">
            {events.data.map((e) => {
              // Someone else took an order over, or it was left too long:
              // the two cases worth a second look.
              const why =
                e.type === 'ClaimReleased'
                  ? (e.payload as { reason?: string } | null)?.reason
                  : undefined;
              return (
                <li
                  key={e.id}
                  data-testid="activity-event"
                  className="flex min-h-row items-center gap-lg py-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-label text-ink">
                      {said(`event.${e.type}`, `${e.streamType}.${e.type}`)}
                    </span>
                    <span className="block text-small text-secondary">
                      {[
                        e.actor?.displayName ?? i18n.t('logs.system'),
                        dateFmt.dateTime(e.occurredAt),
                      ].join(' · ')}
                    </span>
                  </span>
                  {why === 'override' ? (
                    <StatusChip tone="pending">{i18n.t('logs.takenOver')}</StatusChip>
                  ) : why === 'timeout' ? (
                    <StatusChip tone="pending">{i18n.t('logs.timedOut')}</StatusChip>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {session?.roleSlugs.includes('super_admin') ? (
        <section className="flex flex-col gap-md">
          <button
            type="button"
            aria-expanded={debug}
            data-testid="activity-debug"
            onClick={() => setDebug(!debug)}
            className={cn(CAPSULE, 'self-start bg-surface-sunken text-ink')}
          >
            {i18n.t('logs.debug')}
          </button>
          {debug ? (
            <Suspense fallback={null}>
              <div className="-mx-page">
                <DebugPage />
              </div>
            </Suspense>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Who changed what in the set-up: products, stores, roles. A sentence
 * per change, with who and when and for which store. The owner of the
 * installation can open a change to what exactly was sent.
 */
export function AuditScreen() {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const said = useSaid();
  const session = useAuthStore((s) => s.session);
  const stores = session?.stores ?? [];
  const [storeId, setStoreId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const audit = trpc.admin.adminAuditList.useQuery({
    limit: PAGE_SIZE.list,
    ...(storeId ? { storeId } : {}),
  });
  // A store that has since been archived has no name here; an id would
  // tell nobody anything, so it is left out.
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? null;
  // Raw input is for whoever looks after the installation.
  const inspects = !!session?.roleSlugs.includes('super_admin');
  const open = audit.data?.find((r) => r.id === openId) ?? null;
  const what = (action: string) => said(`audit.${action.replace(/^admin\./, '')}`, action);

  return (
    <div className="flex flex-col gap-xl px-page">
      {stores.length > 0 ? (
        <div className="-mx-page flex gap-sm overflow-x-auto px-page">
          {[null, ...stores.map((s) => s.id)].map((id) => (
            <button
              key={id ?? 'all'}
              type="button"
              aria-pressed={storeId === id}
              data-testid="audit-store"
              onClick={() => setStoreId(id)}
              className={pick(storeId === id)}
            >
              {id ? (storeName(id) ?? '') : i18n.t('ops.audit.allScopes')}
            </button>
          ))}
        </div>
      ) : null}

      {audit.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : audit.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : audit.data.length === 0 ? (
        <Nothing title={i18n.t(storeId ? 'logs.auditNoneStore' : 'logs.auditNone') as string} />
      ) : (
        <ul className="flex flex-col">
          {audit.data.map((r) => {
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-ink">{what(r.action)}</span>
                  <span className="block text-small text-secondary">
                    {[
                      r.actor?.displayName ?? i18n.t('logs.system'),
                      dateFmt.dateTime(r.occurredAt),
                      r.scopeStoreId ? storeName(r.scopeStoreId) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {inspects ? (
                  <span className="shrink-0 text-forest">
                    <ChevronIcon />
                  </span>
                ) : null}
              </>
            );
            const row = 'flex min-h-row w-full items-center gap-lg py-sm text-start';
            return (
              <li key={r.id} data-testid="audit-row">
                {inspects ? (
                  <button
                    type="button"
                    onClick={() => setOpenId(r.id)}
                    className={cn(row, 'outline-none active:opacity-60')}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={!!open}
        onOpenChange={(next) => !next && setOpenId(null)}
        title={open ? what(open.action) : ''}
      >
        {open ? (
          <div className="flex flex-col gap-sm">
            <span className="text-body text-secondary">{i18n.t('logs.details')}</span>
            <pre
              dir="ltr"
              className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-lg text-small text-ink"
            >
              {JSON.stringify(open.inputs, null, 2)}
            </pre>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
