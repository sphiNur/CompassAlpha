/**
 * 2026-10-21 CA-03: pick which approved orders go into a run.
 *
 * Sessions are grouped by order date (newest first). Today's group (org
 * timezone, from the server) is ticked by default; an older group is
 * visible, flagged with its age, and unticked until the purchaser ticks
 * it — individually or the whole date at once. Used both before a run
 * exists (what "Start purchasing" will take, plus the booking date) and
 * in the "join new orders" sheet of a run that is already buying.
 *
 * Selection state lives in the caller as per-session overrides of the
 * default (lib/sessionSelection.ts), so orders approved while the screen
 * is open fall into the right default without resetting earlier ticks.
 */
import { Card, Checkbox, SectionLabel } from '@compass/ui';
import type { useI18n } from '../../../hooks/useI18n';
import {
  daysOld,
  groupSessionsByDate,
  selectedSessionIds,
  withGroupSelection,
  type SelectableSession,
  type SessionOverrides,
} from '../lib/sessionSelection';

export function SessionPicker({
  sessions,
  today,
  overrides,
  onChange,
  i18n,
  runDate,
  onRunDateChange,
  bare = false,
}: {
  sessions: readonly SelectableSession[];
  today: string | null;
  overrides: SessionOverrides;
  onChange: (next: Map<string, boolean>) => void;
  i18n: ReturnType<typeof useI18n>;
  /** When set, a date input for the run's booking date is shown. */
  runDate?: string;
  onRunDateChange?: (date: string) => void;
  /** Render without the Card chrome (inside a Sheet). */
  bare?: boolean;
}) {
  const groups = groupSessionsByDate(sessions, today);
  const selected = new Set(selectedSessionIds(sessions, today, overrides));
  const isChecked = (id: string) => selected.has(id);

  const body = (
    <>
      <SectionLabel meta={i18n.t('run.select.meta', { n: selected.size, total: sessions.length })}>
        {i18n.t('run.select.title')}
      </SectionLabel>
      <ul className="flex flex-col" role="list">
        {groups.map((group) => {
          const allOn = group.sessions.every((s) => isChecked(s.id));
          const age = daysOld(group.date, today);
          return (
            <li
              key={group.date || 'none'}
              className="border-b border-[var(--c-divider)] last:border-b-0"
            >
              <div
                className={
                  'flex items-center gap-2 px-3 py-2 ' +
                  (group.isToday ? '' : 'bg-[var(--c-warn-bg)]')
                }
              >
                <Checkbox
                  checked={allOn}
                  onChange={(e) => onChange(withGroupSelection(overrides, group, e.target.checked))}
                  label={
                    <span className="text-old-body font-semibold tabular-nums">
                      {group.date || '—'}
                    </span>
                  }
                />
                <span
                  className={
                    'ml-auto shrink-0 text-old-label ' +
                    (group.isToday ? 'text-[var(--c-fg-muted)]' : 'text-[var(--c-warning-fg)]')
                  }
                >
                  {group.isToday
                    ? i18n.t('run.select.today')
                    : i18n.t('run.select.olderDate', { days: age })}
                </span>
              </div>
              <ul className="flex flex-col pb-1" role="list">
                {group.sessions.map((s) => (
                  <li key={s.id} className="px-3 py-1 pl-8">
                    <Checkbox
                      checked={isChecked(s.id)}
                      onChange={(e) => {
                        const next = new Map(overrides);
                        next.set(s.id, e.target.checked);
                        onChange(next);
                      }}
                      label={<span className="text-old-body">{s.storeName ?? '—'}</span>}
                    />
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {runDate !== undefined && onRunDateChange ? (
        <label className="flex items-center gap-2 border-t border-[var(--c-divider)] px-3 py-2">
          <span className="flex-1 text-old-body">{i18n.t('run.select.runDate')}</span>
          <input
            type="date"
            className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-2 py-1 text-old-body tabular-nums ring-hairline"
            value={runDate}
            max={today ?? undefined}
            onChange={(e) => onRunDateChange(e.target.value)}
          />
        </label>
      ) : null}
      {selected.size === 0 ? (
        <div className="px-3 py-2 text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('run.select.noneSelected')}
        </div>
      ) : null}
    </>
  );
  return bare ? <div className="flex flex-col">{body}</div> : <Card>{body}</Card>;
}
