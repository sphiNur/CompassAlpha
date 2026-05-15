/**
 * DebugPage — admin-only diagnostic console.
 *
 * Three views:
 *   - Live    : in-memory ring buffer from @compass/telemetry
 *   - Server  : the persisted ops.client_logs (system.recentLogs)
 *   - Health  : API + service status
 *
 * Plus an Actions row (Sign out, Reload, Reset session, Copy as JSON) so
 * operators can recover from edge cases without a developer.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  Skeleton,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { getLogger } from '@compass/telemetry';
import type { LogEvent } from '@compass/telemetry';

type Tab = 'live' | 'server' | 'health';
type Level = 'all' | 'debug' | 'info' | 'warn' | 'error';

export function DebugPage() {
  const session = useAuthStore((s) => s.session);
  const clear = useAuthStore((s) => s.clear);
  const [tab, setTab] = useState<Tab>('live');
  const [level, setLevel] = useState<Level>('all');
  const [liveTick, setLiveTick] = useState(0);

  // Live ring buffer subscription (no tRPC).
  const ringBuffer = useMemo<LogEvent[]>(() => {
    try {
      return [...getLogger().getRingBuffer()];
    } catch {
      return [];
    }
  }, [liveTick]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    try {
      unsub = getLogger().subscribe(() => setLiveTick((x) => x + 1));
    } catch {
      /* logger not yet booted in dev */
    }
    return () => {
      unsub?.();
    };
  }, []);

  const sessionId = useMemo(() => {
    try {
      return getLogger().getSessionId();
    } catch {
      return '(no logger)';
    }
  }, []);

  const recent = trpc.system.recentLogs.useQuery(
    { limit: 100, ...(level !== 'all' ? { level } : {}) },
    { enabled: tab === 'server' },
  );

  const health = trpc.system.health.useQuery(undefined, {
    enabled: tab === 'health',
    refetchInterval: tab === 'health' ? 2000 : false,
  });

  if (!session) return null;
  // SECURITY (2026-05-05): Debug console exposes raw error stacks, server
  // logs (potentially with org-scoped data), projector lag, and reset
  // controls. Previously the page was reachable to any signed-in user
  // who happened to discover it via direct render — gating only happened
  // at the Shell level (admin tab visibility). A staff member who had a
  // session before role assignment, or a manager whose `users.manage`
  // gate had a typo, could see internals. Add a hard server-side-aligned
  // check here: the user MUST hold `system.logs.view`. Anyone else gets
  // the auth.noAccess copy instead.
  if (!session.permissions.includes('system.logs.view')) {
    return (
      <div className="flex flex-col gap-3 px-4 py-8">
        <EmptyState
          title="Access not granted"
          description="The debug console is restricted to operators with system-log access."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4 pb-24">
      <header>
        <h1 className="text-h1 font-semibold leading-[1.15] tracking-tight text-[var(--c-fg)]">
          Debug console
        </h1>
        <p className="mt-0.5 font-mono text-label text-[var(--c-fg-muted)]">
          session: {sessionId.slice(0, 12)}… · user: {session.user.displayName}
        </p>
      </header>

      <ChipBar ariaLabel="View">
        <Chip selected={tab === 'live'} onClick={() => setTab('live')}>
          Live ({ringBuffer.length})
        </Chip>
        <Chip selected={tab === 'server'} onClick={() => setTab('server')}>
          Server
        </Chip>
        <Chip selected={tab === 'health'} onClick={() => setTab('health')}>
          Health
        </Chip>
      </ChipBar>

      {(tab === 'live' || tab === 'server') && (
        <ChipBar ariaLabel="Level">
          {(['all', 'debug', 'info', 'warn', 'error'] as Level[]).map((l) => (
            <Chip key={l} selected={level === l} onClick={() => setLevel(l)}>
              {l}
            </Chip>
          ))}
        </ChipBar>
      )}

      {tab === 'live' && (
        <LogList
          events={ringBuffer}
          level={level}
          empty="No client events yet. Tap around the app and they'll show up here."
        />
      )}

      {tab === 'server' && (
        <DataState
          query={recent}
          emptyWhen={(d) => d.length === 0}
          empty={<EmptyState title="No server-side logs" />}
        >
          {(rows) => (
            <ul className="flex flex-col gap-1" role="list">
              {rows.map((r) => (
                <li key={r.id}>
                  <ServerRow row={r} />
                </li>
              ))}
            </ul>
          )}
        </DataState>
      )}

      {tab === 'health' && (
        <Card>
          <CardHeader>
            <CardTitle>API health</CardTitle>
            <CardMeta>Refreshed every 2 s</CardMeta>
          </CardHeader>
          <div className="px-4 pb-4 pt-2">
            {health.isLoading ? (
              <Skeleton className="h-16" />
            ) : health.isError ? (
              <Banner tone="danger" title="API unreachable">
                {health.error.message}
              </Banner>
            ) : health.data ? (
              <dl className="grid grid-cols-2 gap-2 font-mono text-label">
                <dt className="text-[var(--c-fg-muted)]">status</dt>
                <dd>{health.data.status}</dd>
                <dt className="text-[var(--c-fg-muted)]">db</dt>
                <dd>{String(health.data.db)}</dd>
                <dt className="text-[var(--c-fg-muted)]">projector lag</dt>
                <dd>{health.data.projectorLag}</dd>
                <dt className="text-[var(--c-fg-muted)]">version</dt>
                <dd className="truncate">{health.data.version}</dd>
              </dl>
            ) : null}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap gap-2 px-4 pb-4 pt-2">
          <Button
            size="sm"
            variant="utility"
            onClick={() => {
              try {
                getLogger().flush();
              } catch {
                /* noop */
              }
            }}
          >
            Flush logs
          </Button>
          <Button
            size="sm"
            variant="pearl"
            onClick={() => {
              const json = JSON.stringify(ringBuffer, null, 2);
              navigator.clipboard?.writeText(json);
            }}
          >
            Copy live as JSON
          </Button>
          <Button size="sm" variant="pearl" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              clear();
              try {
                window.localStorage.removeItem('compass.auth');
                window.sessionStorage.clear();
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
          >
            Sign out & reset
          </Button>
        </div>
      </Card>
    </div>
  );
}

function LogList({
  events,
  level,
  empty,
}: {
  events: LogEvent[];
  level: Level;
  empty: string;
}) {
  const filtered = useMemo(() => {
    const filteredByLevel = level === 'all' ? events : events.filter((e) => e.level === level);
    return [...filteredByLevel].reverse();
  }, [events, level]);
  if (filtered.length === 0) {
    return <EmptyState title="No matches" description={empty} />;
  }
  return (
    <ul className="flex flex-col gap-1" role="list">
      {filtered.map((e, i) => (
        <li
          key={`${e.clientTs}:${i}`}
          className="rounded-[var(--r-utility)] bg-[var(--c-surface)] px-3 py-2 ring-hairline"
        >
          <div className="flex items-baseline gap-2 font-mono text-label">
            <span className="text-[var(--c-fg-muted)]">
              {new Date(e.clientTs).toLocaleTimeString()}
            </span>
            <Badge
              tone={
                e.level === 'error'
                  ? 'danger'
                  : e.level === 'warn'
                    ? 'warn'
                    : e.level === 'debug'
                      ? 'muted'
                      : 'info'
              }
            >
              {e.level}
            </Badge>
            <span className="font-semibold">{e.kind}</span>
            {e.action ? <span className="text-[var(--c-fg-muted)]">{e.action}</span> : null}
          </div>
          {e.target ? (
            <div className="mt-1 truncate font-mono text-label text-[var(--c-fg-subtle)]">
              {e.target}
            </div>
          ) : null}
          {e.errorMsg ? (
            <div className="mt-1 font-mono text-label text-[var(--c-danger)]">{e.errorMsg}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ServerRow({
  row,
}: {
  // tRPC superjson-less response keeps Dates as ISO strings; we accept both.
  row: {
    id: string;
    level: string;
    kind: string;
    action: string | null;
    target: string | null;
    errorMsg: string | null;
    createdAt: Date | string;
  };
}) {
  return (
    <div className="rounded-[var(--r-utility)] bg-[var(--c-surface)] px-3 py-2 ring-hairline">
      <div className="flex items-baseline gap-2 font-mono text-label">
        <span className="text-[var(--c-fg-muted)]">
          {new Date(row.createdAt).toLocaleTimeString()}
        </span>
        <Badge
          tone={
            row.level === 'error'
              ? 'danger'
              : row.level === 'warn'
                ? 'warn'
                : row.level === 'debug'
                  ? 'muted'
                  : 'info'
          }
        >
          {row.level}
        </Badge>
        <span className="font-semibold">{row.kind}</span>
        {row.action ? <span className="text-[var(--c-fg-muted)]">{row.action}</span> : null}
      </div>
      {row.target ? (
        <div className="mt-1 truncate font-mono text-label text-[var(--c-fg-subtle)]">
          {row.target}
        </div>
      ) : null}
      {row.errorMsg ? (
        <div className="mt-1 font-mono text-label text-[var(--c-danger)]">{row.errorMsg}</div>
      ) : null}
    </div>
  );
}
