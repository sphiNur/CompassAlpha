/**
 * The debug console, inside Admin › Operations › Live activity for super
 * admins (ActivitySection): this device's log as it happens, the logs the
 * workspace's devices sent (system.recentLogs), and the service status,
 * with actions to send the log now, copy it, reload, or sign out.
 *
 * Review COREWEB1-18 / COREWEB1-24 (2026-11-12): every word was English
 * and times followed the browser's language; the views were filter chips
 * (UI-16: switching views is Segmented); each log line was a card of its
 * own (UI-6) and the two lists drew their lines with two copies of one
 * row; the console's title repeated the button that opens it, as a second
 * <h1> inside the Operations screen; and the status showed a "projector
 * lag" the server always reports as 0, not the messages waiting to send.
 */
import { clearLocalSession } from '../lib/localSession';
import { reloadApp } from '../lib/reload';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
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
  DetailRow,
  EmptyState,
  Segmented,
  Skeleton,
  rowGroupClass,
  useToast,
} from '@compass/ui';
import type { CatalogKey } from '@compass/i18n';
import { getLogger, type LogEvent, type LogLevel } from '@compass/telemetry';
import { copyText } from '../lib/clipboard';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { lastUpdatedLabel } from '../hooks/useCachedDataAge';
import { useDateFormat, useI18n } from '../hooks/useI18n';

type View = 'device' | 'all' | 'status';
const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_KEY: Record<Level, CatalogKey> = {
  all: 'ops.debug.level.all',
  debug: 'ops.debug.level.debug',
  info: 'ops.debug.level.info',
  warn: 'ops.debug.level.warn',
  error: 'ops.debug.level.error',
};

const LEVEL_TONE: Record<LogLevel, ComponentProps<typeof Badge>['tone']> = {
  error: 'danger',
  warn: 'warn',
  info: 'info',
  debug: 'muted',
};

function isLogLevel(level: string): level is LogLevel {
  return level === 'debug' || level === 'info' || level === 'warn' || level === 'error';
}

/** A copy of this device's log buffer; empty before the logger starts (dev). */
function readRingBuffer(): LogEvent[] {
  try {
    return [...getLogger().getRingBuffer()];
  } catch {
    return [];
  }
}

/** One line of either list: this device's events or the saved ones. */
interface LogLine {
  key: string;
  at: number;
  level: string;
  kind: string;
  action: string | null;
  target: string | null;
  errorMsg: string | null;
}

export function DebugPage() {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const signOut = trpc.auth.signOut.useMutation();
  const toast = useToast();
  const [view, setView] = useState<View>('device');
  const [level, setLevel] = useState<Level>('all');
  // This device's ring buffer, copied again each time the logger adds to
  // it (no tRPC).
  const [ringBuffer, setRingBuffer] = useState<LogEvent[]>(readRingBuffer);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    try {
      unsub = getLogger().subscribe(() => setRingBuffer(readRingBuffer()));
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
      return null;
    }
  }, []);

  const recent = trpc.system.recentLogs.useQuery(
    { limit: 100, ...(level !== 'all' ? { level } : {}) },
    { enabled: view === 'all' },
  );

  const health = trpc.system.health.useQuery(undefined, {
    enabled: view === 'status',
    refetchInterval: view === 'status' ? 2000 : false,
  });

  if (!session) return null;
  // SECURITY (2026-05-05): the console shows error stacks, the workspace's
  // logs and reset controls. The Operations screen opens it for super
  // admins; this checks the permission the server checks as well.
  if (!session.permissions.includes('system.logs.view')) {
    return (
      <div className="px-4 py-8">
        <EmptyState
          title={i18n.t('ops.debug.noAccess.title')}
          description={i18n.t('ops.debug.noAccess.body')}
        />
      </div>
    );
  }

  const deviceLines: LogLine[] = ringBuffer
    .filter((e) => level === 'all' || e.level === level)
    .map((e, i) => ({
      key: `${e.clientTs}:${i}`,
      at: e.clientTs,
      level: e.level,
      kind: e.kind,
      action: e.action ?? null,
      target: e.target ?? null,
      errorMsg: e.errorMsg ?? null,
    }))
    .reverse();

  return (
    <div className="flex flex-col gap-3 px-4 pb-24 pt-3">
      {sessionId ? (
        <p className="text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('ops.debug.logId', { value: sessionId.slice(0, 12) })}
        </p>
      ) : null}
      <Segmented
        ariaLabel={i18n.t('ops.debug.views')}
        value={view}
        onChange={setView}
        options={[
          { value: 'device', label: i18n.t('ops.debug.view.device') },
          { value: 'all', label: i18n.t('ops.debug.view.all') },
          { value: 'status', label: i18n.t('ops.debug.view.status') },
        ]}
      />

      {view !== 'status' ? (
        // On the 16 px gutter; the strip itself still scrolls edge to edge.
        <ChipBar ariaLabel={i18n.t('ops.debug.levels')} className="-mx-4 -my-1.5 px-4 py-1.5">
          {LEVELS.map((l) => (
            <Chip key={l} selected={level === l} onClick={() => setLevel(l)}>
              {i18n.t(LEVEL_KEY[l])}
            </Chip>
          ))}
        </ChipBar>
      ) : null}

      {view === 'device' ? (
        ringBuffer.length === 0 ? (
          <EmptyState
            title={i18n.t('ops.debug.device.empty')}
            description={i18n.t('ops.debug.device.emptyBody')}
          />
        ) : deviceLines.length === 0 ? (
          <EmptyState title={i18n.t('ops.debug.noMatches')} />
        ) : (
          <LogList lines={deviceLines} />
        )
      ) : null}

      {view === 'all' ? (
        <DataState
          query={recent}
          emptyWhen={(rows) => rows.length === 0}
          empty={
            <EmptyState
              title={i18n.t(level === 'all' ? 'ops.debug.all.empty' : 'ops.debug.noMatches')}
            />
          }
        >
          {(rows) => (
            <LogList
              lines={rows.map((r) => ({
                key: r.id,
                at: new Date(r.createdAt).getTime(),
                level: r.level,
                kind: r.kind,
                action: r.action,
                target: r.target,
                errorMsg: r.errorMsg,
              }))}
            />
          )}
        </DataState>
      ) : null}

      {view === 'status' ? (
        <Card>
          <CardHeader>
            <CardTitle>{i18n.t('ops.debug.status.title')}</CardTitle>
            <CardMeta>{i18n.t('ops.debug.status.refresh')}</CardMeta>
          </CardHeader>
          <div className="flex flex-col gap-2 px-4 pb-4 pt-2">
            {health.isLoading ? (
              <Skeleton className="h-16" />
            ) : health.isError ? (
              <Banner tone="danger" title={i18n.t('ops.debug.status.failed')} />
            ) : health.data ? (
              <>
                <DetailRow
                  label={i18n.t('ops.debug.status.state')}
                  value={i18n.t(
                    health.data.status === 'ok'
                      ? 'ops.debug.status.ok'
                      : 'ops.debug.status.degraded',
                  )}
                />
                <DetailRow
                  label={i18n.t('ops.debug.status.database')}
                  value={i18n.t(
                    health.data.db ? 'ops.debug.status.reachable' : 'ops.debug.status.unreachable',
                  )}
                />
                <DetailRow
                  label={i18n.t('ops.debug.status.waiting')}
                  value={health.data.outboxPending}
                />
                {/* UI-14: the build is a code, so monospace. */}
                <DetailRow
                  label={i18n.t('ops.debug.status.version')}
                  value={<span className="font-mono">{health.data.version}</span>}
                />
              </>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{i18n.t('ops.debug.actions')}</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap gap-2 px-4 pb-4 pt-2">
          <Button
            size="sm"
            variant="pearl"
            onClick={() => {
              try {
                getLogger().flush();
              } catch {
                /* logger not booted: nothing to send */
              }
            }}
          >
            {i18n.t('ops.debug.sendNow')}
          </Button>
          <Button
            size="sm"
            variant="pearl"
            onClick={() => {
              void copyText(JSON.stringify(ringBuffer, null, 2)).then((ok) => {
                if (ok) toast.success(i18n.t('ops.debug.copied'));
              });
            }}
          >
            {i18n.t('ops.debug.copyDevice')}
          </Button>
          <Button size="sm" variant="pearl" onClick={() => reloadApp('debug-page')}>
            {i18n.t('ops.debug.reload')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={signOut.isPending}
            onClick={() => {
              // 2026-10-21 audit CA-33: a real sign-out — the server revokes
              // the refresh tokens first. A network failure (or a hang past
              // 4 s) must not trap the operator, so local state is wiped
              // regardless, as the crash screen's reset wipes it.
              const timeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
              void Promise.race([signOut.mutateAsync().then(() => undefined), timeout])
                .catch(() => undefined)
                .then(clearLocalSession)
                .then(() => reloadApp('debug-page'));
            }}
          >
            {i18n.t('ops.debug.signOut')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Log lines as rows of one card (UI-6), newest first. */
function LogList({ lines }: { lines: LogLine[] }) {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  // Today's lines by the second; an older one says its day too.
  const time = (at: number) =>
    lastUpdatedLabel(at, { time: dateFmt.timeSeconds, calendarDay: dateFmt.calendarDay });
  return (
    <ul className={rowGroupClass} role="list">
      {lines.map((line) => (
        <li key={line.key} className="px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-old-label">
            <span className="tabular-nums text-[var(--c-fg-muted)]">{time(line.at)}</span>
            {isLogLevel(line.level) ? (
              <Badge tone={LEVEL_TONE[line.level]}>{i18n.t(LEVEL_KEY[line.level])}</Badge>
            ) : (
              <Badge tone="muted">{line.level}</Badge>
            )}
            <span className="font-semibold">{line.kind}</span>
            {line.action ? <span className="text-[var(--c-fg-muted)]">{line.action}</span> : null}
          </div>
          {line.target ? (
            <div className="mt-1 truncate font-mono text-old-label text-[var(--c-fg-subtle)]">
              {line.target}
            </div>
          ) : null}
          {line.errorMsg ? (
            <div className="mt-1 break-words font-mono text-old-label text-[var(--c-danger)]">
              {line.errorMsg}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
