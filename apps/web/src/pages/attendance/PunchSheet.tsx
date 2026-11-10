/**
 * The clock sheet (owner, 2026-11-07, "straight on"): the camera, then
 * "checking", then the result, all in one sheet and without a look at the
 * photos. The photos still go to the server and to the managers' sheet;
 * the person clocking just does not stop to see them.
 *
 * A colleague's punch says whose it was, big, with "Not <name>" while it
 * can still be taken back, in case the face was taken for the wrong
 * colleague. A refusal says why and offers the next try right here.
 */
import { useEffect, useRef, useState } from 'react';
import { Avatar, Banner, Button, Sheet, Spinner, Textarea } from '@compass/ui';
import type { CatalogKey } from '@compass/i18n';
import { useI18n } from '../../hooks/useI18n';
import { minutesText } from '../../lib/attendanceFormat';
import type { ErrorVars } from '../../lib/errorText';
import { PunchCamera, type PunchPhotos, type Turn } from './PunchCamera';
import type { Act } from './faceActs';

export type PunchResult = {
  /** The punch row; empty when it was recorded before (`already`). */
  id: string;
  kind: 'in' | 'out';
  time: string;
  /** The colleague clocked on this phone; null = this phone's own person. */
  forName: string | null;
  /** From a new phone: recorded, marked for the managers. */
  flagged: boolean;
  /** Recorded before: an answer lost on the way, or a second try. */
  already: boolean;
  /** Until when (Date.now() ms) "Not <name>" can take it back; null = it cannot. */
  undoUntil: number | null;
};

export type PunchView =
  /** A clock-out past the shift: why. `then`: the camera next, or the photos taken go again. */
  | { at: 'reason'; minutes: number; name: string | null; then: 'camera' | 'send' }
  | { at: 'camera'; round: number; turns: Turn[]; acts: Act[]; notice: CatalogKey | null }
  /** `since`: when this wait began (Date.now() ms); resends keep it. */
  | { at: 'wait'; label: 'checking' | 'preparing'; since: number }
  | { at: 'done'; result: PunchResult }
  | {
      at: 'failed';
      title: CatalogKey;
      vars: ErrorVars;
      body: CatalogKey | null;
      /** The next try offered (with the photos again, or a new face check), or none. */
      action: 'retry' | 'resend' | 'forSelf' | null;
    };

/** How long a result stays before the sheet closes by itself (owner's choice, 2026-11-07). */
const DONE_MS = { self: 3_000, colleague: 8_000, already: 4_000 };
/** When "checking" adds that the link is slow. */
const SLOW_MS = 10_000;
/**
 * When a wait can be closed (ATT-04, 2026-11-09). A punch carries photos:
 * 120 s per try and two resends could hold the sheet for six minutes.
 */
export const WAIT_CLOSABLE_MS = 30_000;

export function PunchSheet({
  view,
  title,
  storeName,
  identifying,
  reasonDraft,
  undoPending,
  onCaptured,
  onReason,
  onRetry,
  onResend,
  onForSelf,
  onUndo,
  onClose,
}: {
  view: PunchView | null;
  title: string;
  storeName: string;
  identifying: boolean;
  /** A reason typed before, kept when the face check has to be done again. */
  reasonDraft: string;
  undoPending: boolean;
  onCaptured: (photos: PunchPhotos) => void;
  onReason: (reason: string) => void;
  onRetry: () => void;
  onResend: () => void;
  onForSelf: () => void;
  onUndo: () => void;
  onClose: () => void;
}) {
  // Nothing closes the sheet while the punch is on its way (it may be
  // recorded already, and the result is what the person waits for), until
  // the wait has gone on for WAIT_CLOSABLE_MS.
  const closable = useWaitClosable(view);
  const locked = (view?.at === 'wait' && !closable) || undoPending;
  return (
    <Sheet open={view !== null} onOpenChange={(o) => !o && !locked && onClose()} title={title}>
      <div className="flex flex-col gap-3 py-3">
        {view?.at === 'camera' ? (
          <PunchCamera
            key={view.round}
            turns={view.turns}
            acts={view.acts}
            identifying={identifying}
            notice={view.notice}
            onCaptured={onCaptured}
            onCancel={onClose}
          />
        ) : null}
        {view?.at === 'wait' ? (
          <Waiting label={view.label} closable={closable} onClose={onClose} />
        ) : null}
        {view?.at === 'reason' ? (
          <ReasonForm
            minutes={view.minutes}
            name={view.name}
            then={view.then}
            draft={reasonDraft}
            onSubmit={onReason}
          />
        ) : null}
        {view?.at === 'done' ? (
          <Done
            result={view.result}
            storeName={storeName}
            undoPending={undoPending}
            onUndo={onUndo}
            onClose={onClose}
          />
        ) : null}
        {view?.at === 'failed' ? (
          <Failed
            view={view}
            onRetry={onRetry}
            onResend={onResend}
            onForSelf={onForSelf}
            onClose={onClose}
          />
        ) : null}
      </div>
    </Sheet>
  );
}

/** Whether the wait on screen has lasted WAIT_CLOSABLE_MS. */
function useWaitClosable(view: PunchView | null): boolean {
  const since = view?.at === 'wait' ? view.since : null;
  // The `since` of the wait whose time is up.
  const [due, setDue] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const t = setTimeout(() => setDue(since), since + WAIT_CLOSABLE_MS - Date.now());
    return () => clearTimeout(t);
  }, [since]);
  return since !== null && due === since;
}

function Waiting({
  label,
  closable,
  onClose,
}: {
  label: 'checking' | 'preparing';
  closable: boolean;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, []);
  const checking = label === 'checking';
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center" role="status">
      <Spinner size={40} className="text-[var(--c-action)]" />
      <p className="text-old-h3 font-semibold text-[var(--c-fg)]">
        {i18n.t(checking ? 'attendance.punch.checking' : 'attendance.punch.preparing')}
      </p>
      {checking && (slow || closable) ? (
        <p className="text-old-label text-[var(--c-fg-muted)]">
          {i18n.t(closable ? 'attendance.punch.checkingLong' : 'attendance.punch.checkingSlow')}
        </p>
      ) : null}
      {closable ? (
        <Button variant="secondary" onClick={onClose}>
          {i18n.t('common.gotIt')}
        </Button>
      ) : null}
    </div>
  );
}

function ReasonForm({
  minutes,
  name,
  then,
  draft,
  onSubmit,
}: {
  minutes: number;
  name: string | null;
  then: 'camera' | 'send';
  draft: string;
  onSubmit: (reason: string) => void;
}) {
  const i18n = useI18n();
  const [text, setText] = useState(draft);
  const duration = minutesText(i18n, minutes);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-old-h3 font-semibold text-[var(--c-fg)]">
        {i18n.t('attendance.overtime.askTitle')}
      </p>
      <p className="text-old-body text-[var(--c-fg-muted)]">
        {name
          ? i18n.t('attendance.overtime.askBodyFor', { name, duration })
          : i18n.t('attendance.overtime.askBody', { duration })}
      </p>
      <Textarea
        rows={3}
        maxLength={300}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={i18n.t('attendance.overtime.reasonPlaceholder')}
        aria-label={i18n.t('attendance.overtime.askTitle')}
      />
      <Button
        block
        size="lg"
        disabled={text.trim().length === 0}
        onClick={() => onSubmit(text.trim())}
      >
        {i18n.t(then === 'camera' ? 'attendance.overtime.continue' : 'attendance.clock.out')}
      </Button>
    </div>
  );
}

function Done({
  result,
  storeName,
  undoPending,
  onUndo,
  onClose,
}: {
  result: PunchResult;
  storeName: string;
  undoPending: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const colleague = result.forName !== null && !result.already;
  const canUndo = colleague && result.undoUntil !== null;
  // Closes by itself; long enough for the people beside the phone to read
  // whose punch it was, and not while "Not <name>" is being sent.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (undoPending) return;
    const ms = result.already ? DONE_MS.already : colleague ? DONE_MS.colleague : DONE_MS.self;
    const t = setTimeout(() => close.current(), ms);
    return () => clearTimeout(t);
  }, [result, colleague, undoPending]);

  const okKind = i18n.t(result.kind === 'in' ? 'attendance.punch.okIn' : 'attendance.punch.okOut');
  return (
    <div className="flex flex-col items-center gap-2 py-4 text-center" role="status">
      <Tick tone={result.flagged ? 'warn' : 'success'} />
      {result.already ? (
        <p className="text-old-h3 font-semibold text-[var(--c-fg)]">
          {result.forName
            ? i18n.t(
                result.kind === 'in'
                  ? 'attendance.punch.alreadyInFor'
                  : 'attendance.punch.alreadyOutFor',
                { name: result.forName, time: result.time },
              )
            : i18n.t(
                result.kind === 'in' ? 'attendance.punch.alreadyIn' : 'attendance.punch.alreadyOut',
                { time: result.time },
              )}
        </p>
      ) : colleague ? (
        <>
          <Avatar name={result.forName!} size={64} />
          <p className="text-old-h1 font-bold text-[var(--c-fg)]">{result.forName}</p>
          <p className="text-old-h3 font-semibold text-[var(--c-fg)]">{okKind}</p>
        </>
      ) : (
        <p className="text-old-h2 font-bold text-[var(--c-fg)]">{okKind}</p>
      )}
      {result.already ? null : (
        <p className="tabular-nums text-old-body text-[var(--c-fg-muted)]">
          {result.time} · {storeName}
        </p>
      )}
      {colleague ? (
        <p className="text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('attendance.punch.told', { name: result.forName! })}
        </p>
      ) : null}
      {result.flagged ? (
        <p className="text-old-label font-semibold text-[var(--c-warning-fg)]">
          {i18n.t('attendance.live.flaggedNote')}
        </p>
      ) : null}
      <div className="mt-3 flex w-full gap-2">
        {canUndo ? (
          <Button variant="secondary" className="flex-1" loading={undoPending} onClick={onUndo}>
            {i18n.t('attendance.punch.notThem', { name: result.forName! })}
          </Button>
        ) : null}
        <Button className="flex-1" disabled={undoPending} onClick={onClose}>
          {i18n.t('attendance.punch.done')}
        </Button>
      </div>
    </div>
  );
}

function Failed({
  view,
  onRetry,
  onResend,
  onForSelf,
  onClose,
}: {
  view: Extract<PunchView, { at: 'failed' }>;
  onRetry: () => void;
  onResend: () => void;
  onForSelf: () => void;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const next =
    view.action === 'retry'
      ? { label: i18n.t('attendance.punch.again'), run: onRetry }
      : view.action === 'resend'
        ? { label: i18n.t('attendance.punch.again'), run: onResend }
        : view.action === 'forSelf'
          ? { label: i18n.t('attendance.punch.forSelf'), run: onForSelf }
          : null;
  return (
    <div className="flex flex-col gap-3">
      <Banner tone="danger" title={i18n.t(view.title, view.vars)} role="alert">
        {view.body ? i18n.t(view.body) : null}
      </Banner>
      {next ? (
        <Button block size="lg" onClick={next.run}>
          {next.label}
        </Button>
      ) : null}
      <Button block variant={next ? 'ghost' : 'secondary'} onClick={onClose}>
        {i18n.t(next ? 'common.cancel' : 'common.gotIt')}
      </Button>
    </div>
  );
}

/** The big tick of a recorded punch. */
function Tick({ tone }: { tone: 'success' | 'warn' }) {
  const color = tone === 'success' ? 'var(--c-success)' : 'var(--c-warning)';
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden className="mb-1">
      <circle cx="32" cy="32" r="30" fill={color} opacity="0.15" />
      <circle cx="32" cy="32" r="30" fill="none" stroke={color} strokeWidth="3" />
      <path
        d="M19 33l9 9 17-19"
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
