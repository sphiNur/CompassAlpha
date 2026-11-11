/**
 * Admin → Operations → Order history: the past 30 days of submitted
 * orders, each card expandable to its lines. Review ADM2-10 (2026-11-11):
 * one file per Operations section.
 */
import { useState } from 'react';
import { Badge, DataState, EmptyState, SectionLabel, Select, rowGroupClass } from '@compass/ui';
import { PAGE_SIZE } from '../../../config/timings';
import { trpc } from '../../../lib/trpc';
import { useDateFormat, useI18n } from '../../../hooks/useI18n';

/**
 * Per-store timeline of submitted orders with outcome + per-contributor
 * breakdown. Read-only — this is the "what did we do recently?" view
 * for managers and admins. Default range: last 30 days.
 */
export function HistorySection() {
  const i18n = useI18n();
  const dates = useDateFormat();
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const stores = trpc.admin.storeList.useQuery();
  const history = trpc.admin.submissionHistory.useQuery({
    storeId: storeFilter ?? undefined,
    limit: PAGE_SIZE.list,
  });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="px-4 py-3">
      <div className="mb-3">
        {/* axe select-name (2026-10-31): the filter had no accessible name. */}
        <Select
          aria-label={i18n.t('run.history.storeFilter')}
          value={storeFilter ?? ''}
          onChange={(e) => setStoreFilter(e.target.value || null)}
        >
          <option value="">{i18n.t('ops.history.allStores')}</option>
          {(stores.data ?? []).map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </Select>
      </div>
      <DataState
        query={history}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('ops.history.emptyTitle')}
            description={i18n.t('ops.history.emptyBody')}
          />
        }
      >
        {(rows) => (
          // Review ADM2-12 (2026-11-11): one card with hairline rows (UI-6),
          // not a stack of cards.
          <ul className={rowGroupClass} role="list">
            {rows.map((r) => {
              const isOpen = openId === r.sessionId;
              const statusTone =
                r.status === 'approved' || r.status === 'in_run' || r.status === 'archived'
                  ? 'success'
                  : r.status === 'rejected'
                    ? 'danger'
                    : 'info';
              return (
                <li key={r.sessionId} className="min-w-0">
                  {/* Review ADM2-32 (2026-11-11): a flat <button> that says
                      whether the card is open. It held the card's <h2> and
                      <p>: block elements inside a <button> are invalid HTML,
                      and the button's role hid the heading anyway. */}
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : r.sessionId)}
                    aria-expanded={isOpen}
                    className="press flex w-full items-start justify-between gap-3 px-4 pt-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block text-old-h2 font-semibold text-[var(--c-fg)]">
                        {r.storeName ?? i18n.t('common.unknownStore')}
                      </span>
                      <span className="block text-old-body-sm text-[var(--c-fg-muted)]">
                        {dates.calendarDay(r.orderDate)}
                        {r.submittedAt
                          ? ` · ${i18n.t('ops.history.submittedAgo', {
                              when: formatRelative(r.submittedAt, i18n),
                            })}`
                          : ''}
                        {r.submittedByName
                          ? ` ${i18n.t('ops.history.byWhom', { name: r.submittedByName })}`
                          : ''}
                      </span>
                    </span>
                    <Badge tone={statusTone}>
                      {i18n.t(
                        ('order.status.' +
                          (r.status === 'rejected' ? 'rejectedTitle' : r.status)) as Parameters<
                          typeof i18n.t
                        >[0],
                      )}
                    </Badge>
                  </button>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-old-label text-[var(--c-fg-muted)]">
                    {/* Walkthrough F14 (2026-11-05): "合计 7.5" added kilos, litres
                        and pieces together; only the product count means
                        something across units. */}
                    <span>{i18n.t('ops.history.skuCount', { n: r.skuCount })}</span>
                    {r.contributors.length > 0 ? (
                      <span>
                        ·{' '}
                        {i18n.t('ops.history.contributorCount', {
                          n: r.contributors.length,
                        })}
                      </span>
                    ) : null}
                    {r.reviewMinutes !== null ? (
                      <span>{i18n.t('ops.history.decidedIn', { n: r.reviewMinutes })}</span>
                    ) : null}
                    {r.decidedByName ? (
                      <span>{i18n.t('ops.history.decidedBy', { name: r.decidedByName })}</span>
                    ) : null}
                  </div>
                  {isOpen ? (
                    <div className="border-t border-[var(--c-divider)] px-4 py-2">
                      <SectionLabel padded={false}>
                        {i18n.t('ops.history.contributorBreakdown')}
                      </SectionLabel>
                      <ul className="mt-2 flex flex-col gap-1">
                        {r.contributors.map((c) => (
                          <li
                            key={c.memberId}
                            className="flex items-baseline justify-between text-old-body"
                          >
                            <span className="truncate text-[var(--c-fg)]">
                              {c.displayName ?? i18n.t('common.unknownMember')}
                            </span>
                            <span className="tabular-nums text-[var(--c-fg-muted)]">
                              {i18n.t('ops.history.skuCount', { n: c.skuCount })}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {r.rejectReason ? (
                        <p className="mt-3 text-old-label text-[var(--c-danger)]">
                          {i18n.t('ops.history.rejectionReason', {
                            reason: r.rejectReason,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </DataState>
    </div>
  );
}

/**
 * Relative "how long ago" label.
 *
 * 2026-07-30: took the i18n instance as a parameter rather than reading a hook,
 * so it stays a pure function (callers are inside components that already have
 * `i18n`). Previously returned hardcoded English — "just now" / "3m ago" —
 * inside an otherwise Chinese activity feed.
 */
function formatRelative(iso: string, i18n: ReturnType<typeof useI18n>): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return i18n.t('time.justNow');
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return i18n.t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  return i18n.t('time.daysAgo', { n: days });
}
