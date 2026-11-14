import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  cn,
  FieldError,
  FieldLabel,
  Input,
  isCommitEnter,
  SectionLabel,
  Select,
  surfaceClass,
} from '@compass/ui';
import { trpc } from '../../lib/trpc';
import {
  badExtraQty,
  cleanExtraRows,
  extraLinesToSave,
  isInvalidExtraRow,
  otherSuggestions,
  unlistedUnit,
  wholeNumberRequired,
  type ExtraDraft,
  type ExtraLine,
} from './extraRows';
import { useI18n, useUnitLabel } from '../../hooks/useI18n';
import { useStableCallbacks } from '../../hooks/useStableCallbacks';
import { formatQty } from '../../lib/format';
import { CANONICAL_UNITS, WHOLE_NUMBER_UNITS, isCanonicalUnit } from '@compass/contracts/limits';

/**
 * Session-level structured "其他物品" extras editor (M3.16-C,
 * 2026-05-16). Replaces SessionNotesEditor / the free-text textarea.
 *
 * Data shape: each extra is { name, qty, unit, note? }. The editor
 * holds the full list locally, mutates it on each row edit, and fires
 * a single setSessionExtras mutation 700 ms after the last keystroke
 * (or immediately on row add / remove). The mutation always sends the
 * WHOLE list — atomic-replace semantics match the domain event.
 *
 * Why a separate component:
 *   - Local rows array means typing doesn't wait for the server.
 *   - Suggestion query is per-row but identical per editor mount;
 *     the dropdown state is scoped inside the row component.
 *   - Stays mounted across refetches; adopts the server array into
 *     local state only when local is clean.
 *
 * Read-only mode: collapses each row to a one-line "name · qty unit"
 * read. Hidden entirely when no extras (read-only + empty list).
 */
export function SessionExtrasEditor({
  sessionId,
  storeId,
  initialValue,
  isReadOnly,
  onSave,
  inSheet = false,
}: {
  /** DX-ORD-12: inside a sheet, which pads its body already. */
  inSheet?: boolean;
  /** null = no session yet (CA-27); the first save lazy-creates it. */
  sessionId: string | null;
  storeId: string;
  initialValue: ExtraDraft[];
  isReadOnly: boolean;
  onSave: (extras: ExtraLine[]) => Promise<void>;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const [rows, setRows] = useState<ExtraDraft[]>(() => initialValue.map((r) => ({ ...r })));
  const lastSavedRef = useRef<string>(JSON.stringify(initialValue));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Adopt server array when local is clean. Compare via JSON string
  // (cheap; arrays are short ≤50 rows). If our local copy doesn't
  // match what we last saved, the user is mid-edit — let them win.
  // Review ORD-31 (2026-11): this and the reset below run when the
  // server's list, or the session, changes; what else they read comes
  // from the latest render (useStableCallbacks) instead of past a
  // silenced dependency lint.
  const serverJson = JSON.stringify(initialValue);
  const { adoptServerRows } = useStableCallbacks({
    adoptServerRows: () => {
      if (JSON.stringify(rows) === lastSavedRef.current) {
        lastSavedRef.current = serverJson;
        setRows(initialValue.map((r) => ({ ...r })));
      }
    },
  });
  useEffect(() => {
    adoptServerRows();
  }, [adoptServerRows, serverJson]);

  // Reset on session swap (different store → different session).
  // 2026-10-21 audit CA-27: NOT when the id merely appears (no session
  // → the draft our own first save / tap just lazy-created, same store)
  // — that reset wiped the rows the user was still typing.
  const resetKeyRef = useRef({ storeId, sessionId });
  const { resetForSession } = useStableCallbacks({
    resetForSession: () => {
      const prev = resetKeyRef.current;
      resetKeyRef.current = { storeId, sessionId };
      if (prev.storeId === storeId && (prev.sessionId === sessionId || prev.sessionId === null)) {
        return;
      }
      const next = initialValue.map((r) => ({ ...r }));
      lastSavedRef.current = JSON.stringify(next);
      setRows(next);
      setSavingState('idle');
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      pendingFireRef.current = null;
    },
  });
  useEffect(() => {
    resetForSession();
  }, [resetForSession, sessionId, storeId]);

  // CA-25: the save waiting out its 700 ms debounce, so unmount /
  // pagehide can send it instead of dropping it.
  const pendingFireRef = useRef<(() => Promise<void>) | null>(null);

  const scheduleSave = useCallback(
    (next: ExtraDraft[], { immediate = false, onCommit = false } = {}) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      pendingFireRef.current = null;
      const fire = async () => {
        // ORD-13: null while a row has a unit from before M3.34; the row
        // asks for one from the list.
        const cleaned = extraLinesToSave(next);
        if (cleaned === null) {
          setSavingState('idle');
          return;
        }
        const cleanedJson = JSON.stringify(cleaned);
        // 2026-10-21 audit CA-27 (B-09): rows extraLinesToSave leaves out
        // (no name, bad / zero qty) are NOT persisted — don't claim "Saved ✓"
        // while any are on screen; invalid named rows are flagged inline.
        const allPersisted = cleaned.length === next.length;
        if (cleanedJson === lastSavedRef.current) {
          if (!allPersisted) setSavingState('idle');
          return;
        }
        setSavingState('saving');
        try {
          await onSave(cleaned);
          lastSavedRef.current = cleanedJson;
          if (allPersisted) {
            setSavingState('saved');
            setTimeout(() => setSavingState('idle'), 1500);
          } else {
            setSavingState('idle');
          }
        } catch {
          setSavingState('idle');
        }
      };
      if (immediate) {
        void fire();
      } else if (onCommit) {
        // DX-ORD-13: a name being typed waits for the field to be left (or
        // Enter). Unmount / pagehide still send it (flushPendingSave).
        pendingFireRef.current = fire;
      } else {
        pendingFireRef.current = fire;
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          pendingFireRef.current = null;
          void fire();
        }, 700);
      }
    },
    [onSave],
  );

  // 2026-10-21 audit CA-25: send (don't drop) a debounced save on
  // unmount and on pagehide.
  const flushPendingSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const fire = pendingFireRef.current;
    pendingFireRef.current = null;
    if (fire) void fire();
  }, []);
  useEffect(() => {
    window.addEventListener('pagehide', flushPendingSave);
    return () => {
      window.removeEventListener('pagehide', flushPendingSave);
      flushPendingSave();
    };
  }, [flushPendingSave]);

  // Read-only and nothing to show → render nothing (avoids an empty
  // section under a submitted/approved session).
  const cleanedView = cleanExtraRows(rows);
  if (isReadOnly && cleanedView.length === 0) return null;

  const updateRow = (idx: number, patch: Partial<ExtraDraft>) => {
    // DX-ORD-13 (2026-11-01): a pause while typing the name saved the half
    // typed word ("Lau") into the order's history. Name edits are saved
    // when the name field is left; quantity and unit after a short pause.
    const nameOnly = Object.keys(patch).every((k) => k === 'name');
    setRows((prev) => {
      const next = prev.map((r, i) => (i === idx ? { ...r, ...patch } : r));
      scheduleSave(next, { onCommit: nameOnly });
      return next;
    });
  };
  // After the render that applied the last edit, so the save sees it.
  const commitName = () => {
    setTimeout(flushPendingSave, 0);
  };
  const removeRow = (idx: number) => {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      scheduleSave(next, { immediate: true });
      return next;
    });
  };
  const addRow = () => {
    setRows((prev) => {
      if (prev.length >= 50) return prev;
      const next: ExtraDraft[] = [...prev, { name: '', qty: '1', unit: 'kg' as const }];
      // Don't fire save immediately — name is empty, cleanExtraRows
      // drops it. The save fires when the user types into the name field.
      return next;
    });
  };

  return (
    <section className={cn('mt-2 pb-4 pt-1', !inSheet && 'px-4')}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <SectionLabel padded={false}>{i18n.t('order.extras.label')}</SectionLabel>
        <span className="text-old-label text-[var(--c-fg-muted)]">
          {savingState === 'saving'
            ? i18n.t('order.notes.saving')
            : savingState === 'saved'
              ? i18n.t('order.notes.saved')
              : ''}
        </span>
      </div>

      {isReadOnly ? (
        <ul className={cn(surfaceClass, 'flex flex-col gap-1 px-3 py-2')}>
          {cleanedView.map((r, i) => (
            <li
              key={`${r.name}-${i}`}
              className="flex items-baseline justify-between gap-2 text-old-body"
            >
              <span className="min-w-0 flex-1 break-words text-[var(--c-fg)]">{r.name}</span>
              <span className="shrink-0 tabular-nums text-[var(--c-fg-muted)]">
                {formatQty(r.qty)} {unitLabel(r.unit, r.qty)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row, idx) => (
            <ExtraRowEditor
              key={idx}
              row={row}
              invalid={isInvalidExtraRow(row)}
              storeId={storeId}
              onChange={(patch) => updateRow(idx, patch)}
              onNameCommit={commitName}
              onRemove={() => removeRow(idx)}
            />
          ))}
          <Button
            size="sm"
            variant="pearl"
            onClick={addRow}
            disabled={rows.length >= 50}
            className="self-start"
          >
            {i18n.t('order.extras.add')}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * One row of the SessionExtrasEditor: name (with autocomplete), qty,
 * unit, remove. The autocomplete query fires on focus + as the user
 * types (debounced via react-query's natural caching — same key →
 * cached result for ~30s).
 */

function ExtraRowEditor({
  row,
  invalid = false,
  storeId,
  onChange,
  onNameCommit,
  onRemove,
}: {
  row: ExtraDraft;
  /** Not saved: named but with an invalid qty (B-09). */
  invalid?: boolean;
  storeId: string;
  onChange: (patch: Partial<ExtraDraft>) => void;
  /** DX-ORD-13: the name is done (field left, Enter, suggestion picked). */
  onNameCommit: () => void;
  onRemove: () => void;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const errorId = useId();
  const nameId = useId();
  const [focusing, setFocusing] = useState(false);
  // Suggestions query — fetches up to 20 distinct names this store
  // has used in the last 30 days. Enabled only while the name input
  // is focused so we don't fan out 5 simultaneous queries for 5
  // rows on every editor mount.
  const suggestionsQuery = trpc.order.extrasSuggestions.useQuery(
    { storeId, search: row.name },
    { enabled: focusing && storeId.length > 0, staleTime: 30_000 },
  );
  const suggestions = otherSuggestions(suggestionsQuery.data ?? [], row.name);

  return (
    <div className={cn(surfaceClass, 'p-2', invalid && 'ring-1 ring-[var(--c-danger)]')}>
      {/* Walkthrough F1 (2026-11-05): name, qty, unit and remove shared one
          line, leaving the name a sliver (and less in Russian). The name
          now has its own line; qty and unit sit under it. V11: items-end,
          so the remove button stays level with the field under its label. */}
      <div className="flex items-end gap-2">
        <div
          className="relative min-w-0 flex-1"
          // Focus moving to a suggestion (Tab) stays "in" the name field;
          // leaving both commits the name and closes the list. Delayed so
          // a suggestion's tap registers before the list hides.
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            onNameCommit();
            setTimeout(() => setFocusing(false), 120);
          }}
        >
          {/* DX-ORD-8 (2026-11-01): the placeholder was the only name, and
              it is gone once something is typed. Review MWA-20 (V11,
              modern-web-guidance: forms): "Placeholders are not persistent
              labels" — a small visible label names the field now, so it
              stays when text is typed; the name is unchanged ("Item name"). */}
          <FieldLabel htmlFor={nameId} className="mb-1">
            {i18n.t('order.extras.namePlaceholder')}
          </FieldLabel>
          <Input
            id={nameId}
            value={row.name}
            maxLength={200}
            onChange={(e) => onChange({ name: e.target.value })}
            onFocus={() => setFocusing(true)}
            onKeyDown={(e) => {
              if (isCommitEnter(e)) onNameCommit();
            }}
          />
          {/* Review ORD-23 (2026-11): a plain list of buttons. It was marked
              a listbox, whose items must be options the field points at
              (combobox), which these are not. */}
          {focusing && suggestions.length > 0 ? (
            <ul
              role="list"
              className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-[var(--r-card)] bg-[var(--c-surface-elevated)] py-1 shadow-product ring-hairline"
            >
              {suggestions.slice(0, 6).map((s) => (
                <li key={s.name}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // mousedown fires BEFORE blur — onClick would
                      // miss because blur hides the dropdown first.
                      e.preventDefault();
                      onChange({ name: s.name });
                      onNameCommit();
                      setFocusing(false);
                    }}
                    // Keyboard: Enter / Space on a suggestion reached by Tab.
                    onClick={(e) => {
                      if (e.detail !== 0) return; // pointer taps went through mousedown
                      onChange({ name: s.name });
                      onNameCommit();
                      setFocusing(false);
                    }}
                    className="press flex min-h-11 w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-old-body hover:bg-[var(--c-surface-2)]"
                  >
                    <span className="text-[var(--c-fg)]">{s.name}</span>
                    {/* ORD-23: "×3" read as "times 3" and looked like a quantity. */}
                    <span className="text-old-label text-[var(--c-fg-muted)]">
                      {i18n.t('order.extras.usedCount', { n: s.count })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {/* V11: centred on the field, not on the field and its label. */}
        <div className="flex h-[var(--control-h)] shrink-0 items-center">
          <RemoveExtraButton label={i18n.t('order.extras.remove')} onClick={onRemove} />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Input
          type="number"
          value={row.qty}
          // M3.34 (2026-05-19): inputMode tracks the unit so a pcs/bunch
          // row gives an integer keypad while a kg/L row allows decimals.
          // Prevents accidental decimal-in-pcs typos (e.g. "1.5 个 of 鸡蛋"
          // doesn't make sense). ORD-13: no step or min, which this text
          // field ignored.
          inputMode={WHOLE_NUMBER_UNITS.has(row.unit) ? 'numeric' : 'decimal'}
          invalid={invalid && badExtraQty(row)}
          aria-describedby={invalid && badExtraQty(row) ? errorId : undefined}
          aria-label={i18n.t('order.extras.qtyLabel')}
          className="w-24 text-center"
          onChange={(e) => onChange({ qty: e.target.value })}
        />
        <div className="w-28 shrink-0">
          <Select
            value={row.unit}
            aria-label={i18n.t('order.extras.unitLabel')}
            invalid={unlistedUnit(row)}
            aria-describedby={invalid && unlistedUnit(row) ? errorId : undefined}
            // M3.34: constrained to canonical units (CanonicalUnitSchema).
            // Free-text caused "kg"/"kgs"/"公斤" drift that broke
            // aggregation + i18n. Labels go through useUnitLabel so the
            // visible option text matches the rest of the UI in the
            // user's locale.
            onChange={(e) => onChange({ unit: e.target.value })}
            className="pl-3 pr-7 text-old-body"
          >
            {/* ORD-13: a unit from before M3.34, as written, until one
                from the list is picked. */}
            {isCanonicalUnit(row.unit) ? null : <option value={row.unit}>{row.unit}</option>}
            {CANONICAL_UNITS.map((u) => (
              <option key={u} value={u}>
                {unitLabel.uncounted(u)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {/* UI-02: the kit's error line, tied to the field it is about. */}
      {invalid ? (
        <FieldError id={errorId} className="px-1">
          {unlistedUnit(row)
            ? i18n.t('order.extras.chooseUnit')
            : wholeNumberRequired(row)
              ? i18n.t('order.extras.wholeNumber')
              : i18n.t('order.errors.invalidQty')}
        </FieldError>
      ) : null}
    </div>
  );
}

function RemoveExtraButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      // ORD-22: hit-44, a 44 px tap area around the 36 px circle.
      className={cn(
        'press hit-44 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
        'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)] ring-hairline',
        'hover:text-[var(--c-danger)]',
      )}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <path
          d="M3.5 3.5l7 7M10.5 3.5l-7 7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
