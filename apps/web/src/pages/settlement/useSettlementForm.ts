/**
 * The daily close form: which store and day, the record on screen, the
 * draft over it (kept on this device while unsaved), what stops it from
 * being saved, leaving without saving, and saving. Review CONF-06: moved
 * out of SettlementPage, which draws what this returns.
 */
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useToast } from '@compass/ui';
import { BACKDATE_LIMIT_DAYS, isoDateDaysBefore } from '@compass/contracts/limits';
import { newIdempotencyKey, trpc } from '../../lib/trpc';
import { useStoreContext } from '../../components/StoreSwitcher';
import { haptic } from '../../hooks/useTelegram';
import { useI18n } from '../../hooks/useI18n';
import { useLeaveGuards } from '../../hooks/useLeaveGuards';
import { useStableCallbacks } from '../../hooks/useStableCallbacks';
import { confirmNative, confirmThen } from '../../lib/confirm';
import { showFieldError, withTouched } from '../../lib/fieldErrors';
import { useErrToast } from '../../lib/errToast';
import { currencyOf } from '../../lib/format';
import { focusFirstInvalid } from '../../lib/focusFirstInvalid';
import { useRefreshSession } from '../../lib/refreshSession';
import { useAuthStore } from '../../stores/authStore';
import {
  draftKey,
  draftStorage,
  forgetDraft,
  pruneDrafts,
  readDraft,
  writeDraft,
} from './draftStore';
import {
  BUSINESS_DATE,
  DIRECT_MONEY_FIELDS,
  closeChanges,
  closeMoney,
  countFieldsToFix,
  detailTotals,
  detailsInvalid,
  directMoneyValid,
  draftFromRecord,
  editedFields,
  emptyDraft,
  isAllZeroClose,
  isVersionConflict,
  linesEdited,
  newCloseHasInput,
  settlementSaveInput,
  settlementSummary,
  type CarriedFields,
  type MoneyField,
  type OperatingExpenseDraft,
  type SettlementDraft,
  type SettlementRecord,
  type WageItemDraft,
} from './draftModel';
import type { FieldReveal } from './DetailLine';

export function useSettlementForm() {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const session = useAuthStore((state) => state.session);
  const storeCtx = useStoreContext();
  const requestedStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const setCurrentStore = useAuthStore((state) => state.setCurrentStore);
  const storesQuery = trpc.catalog.stores.useQuery(
    { permission: 'settlement.record' },
    { enabled: !!session },
  );
  const eligibleStores = storesQuery.data ?? [];
  const currentStoreId =
    eligibleStores.find((store) => store.id === requestedStoreId)?.id ??
    eligibleStores[0]?.id ??
    null;
  const currency = currencyOf(session);
  const [date, setDate] = useState('');
  const [draft, setDraft] = useState<SettlementDraft>(emptyDraft);
  const [draftRecordKey, setDraftRecordKey] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  // CLS-18: the record the form was loaded from, and the user's own typed
  // fields to put back on top of a newer version after a conflict refresh.
  const baseDraft = useRef<SettlementDraft>(emptyDraft());
  const carryOver = useRef<{ at: string; fields: CarriedFields } | null>(null);
  // F18 (2026-11-05): true while the form shows unsaved input brought back
  // from this device (see settlement/draftStore).
  const [restoredDraft, setRestoredDraft] = useState(false);

  const businessDateQuery = trpc.settlement.businessDate.useQuery(
    { storeId: currentStoreId ?? '' },
    { enabled: !!currentStoreId },
  );
  const businessDate =
    businessDateQuery.data?.storeId === currentStoreId ? businessDateQuery.data : null;
  const closeQuery = trpc.settlement.get.useQuery(
    { storeId: currentStoreId ?? '', date },
    {
      enabled:
        !!currentStoreId && !!businessDate && BUSINESS_DATE.test(date) && date <= businessDate.date,
    },
  );

  // Recover from a persisted/global store that the actor can see but where
  // settlement.record is denied. Keep the shell context aligned with the
  // page-local selector so navigation after a close stays in the same store.
  useEffect(() => {
    if (currentStoreId && currentStoreId !== requestedStoreId) {
      setCurrentStore(currentStoreId);
    }
  }, [currentStoreId, requestedStoreId, setCurrentStore]);
  // CONF-02 (2026-11-09): a store assigned since the session was read is
  // in this page's list but not yet in the session, so it never became
  // the shell's store and the page waited for that forever. Read the
  // session again; the store then joins it.
  const refreshSession = useRefreshSession();
  const storeNotInSession =
    !!currentStoreId && !(session?.stores ?? []).some((store) => store.id === currentStoreId);
  useEffect(() => {
    if (storeNotInSession) void refreshSession();
  }, [storeNotInSession, refreshSession]);

  // The server owns "today" because this is a store business date, not a
  // device date. Reset to that date whenever the selected store changes
  // (the store is a dependency for that, even where the date is the same).
  const businessDay = businessDate?.date;
  const businessDayStore = businessDate?.storeId;
  useEffect(() => {
    if (businessDay) setDate(businessDay);
  }, [businessDay, businessDayStore]);

  // A date switch can briefly retain a previous query result. Only ever use
  // a response for the current store AND date shown in the form.
  const existing: SettlementRecord | null =
    closeQuery.data && closeQuery.data.storeId === currentStoreId && closeQuery.data.date === date
      ? closeQuery.data
      : null;
  const recordKey = `${currentStoreId ?? ''}:${date}:${existing?.id ?? 'new'}:${existing?.version ?? 0}`;

  const { loadRecord } = useStableCallbacks({
    loadRecord: () => {
      if (!currentStoreId) {
        setDraftRecordKey(null);
        return;
      }
      const fresh = existing ? draftFromRecord(existing) : emptyDraft();
      baseDraft.current = fresh;
      const carry = carryOver.current;
      carryOver.current = null;
      const stored =
        session && BUSINESS_DATE.test(date)
          ? readDraft<SettlementDraft>(draftStorage(), draftKey(session.user.id, recordKey))
          : null;
      // CONF-13: tidy the other drafts. Only a record that has loaded says
      // which versions are behind it; while it loads, recordKey reads "new".
      if (session && BUSINESS_DATE.test(date)) {
        pruneDrafts(
          draftStorage(),
          draftKey(session.user.id, recordKey),
          existing
            ? {
                prefix: draftKey(session.user.id, `${currentStoreId}:${date}:${existing.id}:`),
                version: existing.version,
              }
            : null,
        );
      }
      if (carry && carry.at === `${currentStoreId}:${date}` && Object.keys(carry.fields).length) {
        setDraft({ ...fresh, ...carry.fields });
        setRestoredDraft(false);
        toast.info(i18n.t('settlement.conflict.keptEdits'));
      } else if (stored) {
        setDraft({ ...fresh, ...stored });
        setRestoredDraft(true);
      } else {
        setDraft(fresh);
        setRestoredDraft(false);
      }
      setDraftRecordKey(recordKey);
      setVersionConflict(false);
    },
  });
  // Loads when the record on screen changes — its store, day or version,
  // all in `recordKey` — and not when the other values it reads change: a
  // refreshed session or a refetched copy of the same version must not
  // throw away what is being typed.
  useEffect(() => {
    loadRecord();
  }, [loadRecord, currentStoreId, recordKey]);

  const totals = detailTotals(draft);
  const currentMoney = closeMoney(draft, totals);
  const invalidMoney = DIRECT_MONEY_FIELDS.some((field) => !directMoneyValid(draft, field));
  const changes = closeChanges(draft, currentMoney, existing);
  // Historical wage rows keep their name snapshot and may be viewed or left
  // untouched. The moment the wage section changes, every row must be tied to
  // a current store employee before it can be saved.
  const wageSelectionRequired = !existing || changes.wages;
  const invalidDetails = detailsInvalid(draft, totals, wageSelectionRequired);
  // The draft for the record on screen is in. In the render that brings a
  // record, the form still holds the previous one's (or an empty) draft
  // until the effect above replaces it: nothing anyone typed. Counted as
  // changes, a tap on another tab right then asked "discard the changes
  // you have not saved?" about a close saved a moment ago (seen in CI just
  // after a reload).
  const draftLoaded = draftRecordKey === recordKey;
  const hasUnsavedChanges =
    draftLoaded && (existing !== null ? changes.any : newCloseHasInput(draft));
  // F18: keep unsaved input on the device while it differs from the record,
  // and drop it once it matches again (saved, or typed back).
  const storedDraftKey = session ? draftKey(session.user.id, recordKey) : null;
  useEffect(() => {
    if (!storedDraftKey || !draftLoaded) return;
    if (hasUnsavedChanges) writeDraft(draftStorage(), storedDraftKey, draft);
    else forgetDraft(draftStorage(), storedDraftKey);
  }, [storedDraftKey, draftLoaded, hasUnsavedChanges, draft]);
  const forgetStoredDraft = () => {
    if (storedDraftKey) forgetDraft(draftStorage(), storedDraftKey);
    setRestoredDraft(false);
  };
  const discardRestoredDraft = () => {
    forgetStoredDraft();
    setDraft(baseDraft.current);
  };
  const confirmDiscardChanges = (onConfirm: () => void) => {
    const asked = hasUnsavedChanges
      ? confirmNative(i18n.t('settlement.confirm.discard'))
      : Promise.resolve(true);
    void asked.then((confirmed) => {
      if (confirmed) forgetStoredDraft();
      if (confirmed) onConfirm();
    });
  };
  // Read by the tab guard, which is registered before the mutation.
  const savingRef = useRef(false);
  useLeaveGuards({
    dirty: hasUnsavedChanges,
    tab: 'settlement',
    storeId: requestedStoreId,
    saving: savingRef,
    // CONF-13: "discard" drops the stored draft too, as the page's own
    // store and date pickers do; it used to come back as "restored".
    confirmLeave: () =>
      confirmNative(i18n.t('settlement.confirm.discard')).then((ok) => {
        if (ok && storedDraftKey) forgetDraft(draftStorage(), storedDraftKey);
        return ok;
      }),
  });

  const needsCorrectionReason = !!existing && changes.any;
  const correctionReady = !needsCorrectionReason || draft.correctionReason.trim().length > 0;
  const dateValid = !!businessDate && BUSINESS_DATE.test(date) && date <= businessDate.date;
  const draftSynchronized = !closeQuery.isPending && draftLoaded;
  // CLS-14: a NEW close may be at most BACKDATE_LIMIT_DAYS back; an
  // existing older one can still be corrected.
  const tooOldForNew =
    !!businessDate &&
    !existing &&
    !closeQuery.isFetching &&
    date < isoDateDaysBefore(businessDate.date, BACKDATE_LIMIT_DAYS);
  const canSave =
    !!currentStoreId &&
    draftSynchronized &&
    dateValid &&
    !tooOldForNew &&
    !invalidMoney &&
    !invalidDetails &&
    changes.any &&
    correctionReady &&
    !versionConflict &&
    !closeQuery.isFetching &&
    !closeQuery.isError;
  // A11Y-2: the save button stays focusable and jumps to the first field
  // to fix instead of being silently disabled.
  const fieldsToFix = countFieldsToFix(draft, wageSelectionRequired, correctionReady);
  const formRef = useRef<HTMLFieldSetElement>(null);
  // DX-VIS-15 (2026-11-01): expense and wage lines are marked red only
  // after their field was left or a save was tried, not as they appear.
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(() => new Set());
  const [saveTried, setSaveTried] = useState(false);
  const touch = (key: string) => setTouchedFields((cur) => withTouched(cur, key));
  const reveal: FieldReveal = {
    shows: (invalid, key) => showFieldError(invalid, touchedFields, key, saveTried),
    leave: touch,
  };
  // CONF-21: the top amounts reveal a problem the same way.
  const revealFor = (field: MoneyField) => ({
    revealError: saveTried || touchedFields.has(field),
    onLeave: () => touch(field),
  });
  const showFirstFieldToFix = () => {
    // The marks must be on screen before focus can find the first one.
    flushSync(() => setSaveTried(true));
    focusFirstInvalid(formRef.current);
  };

  // CLS-17 (2026-10-30): one key per logical save. Every request used to
  // get a new one, so a retry after a lost response looked like someone
  // else's edit ("changed elsewhere"). Same content → same key.
  const saveIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const saveIdemFor = useRef('');
  const saveMutation = trpc.settlement.save.useMutation({
    trpc: { context: saveIdemCtx },
    onSuccess: (saved) => {
      saveIdemFor.current = '';
      forgetStoredDraft();
      baseDraft.current = draftFromRecord(saved);
      setDraft(baseDraft.current);
      setDraftRecordKey(`${saved.storeId}:${saved.date}:${saved.id}:${saved.version}`);
      setVersionConflict(false);
      haptic('success');
      toast.success(i18n.t('settlement.saved'));
      void utils.settlement.get.invalidate({ storeId: saved.storeId, date: saved.date });
      void utils.settlement.recent.invalidate({ storeId: saved.storeId });
      // RE-CLS-1 (2026-10-31): the change history gained a version.
      void utils.settlement.revisions.invalidate({ settlementId: saved.id });
      // DX-SHL-23: the 日结 tab's "not filed today" dot.
      void utils.nav.counts.invalidate();
    },
    onError: (error) => {
      if (isVersionConflict(error)) {
        setVersionConflict(true);
        haptic('warning');
        return;
      }
      // The server names what to fix (an employee who left, totals that do not
      // add up, a missing correction reason); show that, not "try again".
      // CLS-17: the same content is sent with the same key, so saving
      // again after a lost answer cannot record it twice.
      errToast('settlement.errors.save', { retrySafe: true })(error);
    },
  });

  savingRef.current = saveMutation.isPending;

  const submitSave = () => {
    if (!currentStoreId || !canSave || saveMutation.isPending) return;
    const input = settlementSaveInput({
      storeId: currentStoreId,
      date,
      draft,
      money: currentMoney,
      existing,
      expensesChanged: changes.expenses,
      wagesChanged: changes.wages,
      needsCorrectionReason,
    });
    const signature = JSON.stringify(input);
    if (signature !== saveIdemFor.current) {
      saveIdemFor.current = signature;
      saveIdemCtx.idempotencyKey = newIdempotencyKey();
    }
    saveMutation.mutate(input);
  };

  const save = () => {
    if (!currentStoreId || !canSave || saveMutation.isPending) return;
    if (!existing && isAllZeroClose(draft)) {
      confirmThen(i18n.t('settlement.confirm.allZero'), submitSave);
      return;
    }
    submitSave();
  };

  const refreshRecord = () => {
    const reload = () => {
      setVersionConflict(false);
      void closeQuery.refetch();
      if (currentStoreId) void utils.settlement.recent.invalidate({ storeId: currentStoreId });
    };
    // CLS-18: after a version conflict the newer record loads and the
    // amounts / note this user typed are put back on top of it. Only
    // expense and wage lines cannot be carried over, so ask about those.
    if (versionConflict) {
      carryOver.current = {
        at: `${currentStoreId}:${date}`,
        fields: editedFields(draft, baseDraft.current),
      };
      if (linesEdited(draft, baseDraft.current)) {
        void confirmNative(i18n.t('settlement.conflict.linesLost')).then((ok) => {
          if (ok) reload();
          else carryOver.current = null;
        });
      } else {
        reload();
      }
      return;
    }
    confirmDiscardChanges(reload);
  };

  return {
    session,
    storesQuery,
    eligibleStores,
    currentStoreId,
    requestedStoreId,
    /** Another store, after asking about unsaved input. */
    chooseStore: (storeId: string) => {
      if (storeId === currentStoreId) return;
      confirmDiscardChanges(() => setCurrentStore(storeId));
    },
    currency,
    businessDateQuery,
    businessDate,
    date,
    dateValid,
    /** Another day, after asking about unsaved input. */
    chooseDate: (day: string) => {
      if (day === date) return;
      confirmDiscardChanges(() => setDate(day));
    },
    /** A day from the recent closes, after asking about unsaved input. */
    openDay: (day: string) => {
      if (day === date) return;
      confirmDiscardChanges(() => {
        haptic('light');
        setDate(day);
      });
    },
    closeQuery,
    existing,
    draft,
    edit: {
      money: (field: (typeof DIRECT_MONEY_FIELDS)[number], value: string) =>
        setDraft((current) => ({ ...current, [field]: value })),
      note: (note: string) => setDraft((current) => ({ ...current, note })),
      correctionReason: (correctionReason: string) =>
        setDraft((current) => ({ ...current, correctionReason })),
      expenses: (change: (lines: OperatingExpenseDraft[]) => OperatingExpenseDraft[]) =>
        setDraft((current) => ({
          ...current,
          operatingExpenseItems: change(current.operatingExpenseItems),
        })),
      wages: (change: (lines: WageItemDraft[]) => WageItemDraft[]) =>
        setDraft((current) => ({ ...current, wageItems: change(current.wageItems) })),
    },
    restoredDraft,
    discardRestoredDraft,
    totals,
    summary: settlementSummary(draft, totals),
    invalidMoney,
    invalidDetails,
    wageSelectionRequired,
    needsCorrectionReason,
    correctionReady,
    hasUnsavedChanges,
    draftSynchronized,
    tooOldForNew,
    versionConflict,
    canSave,
    fieldsToFix,
    formRef,
    reveal,
    revealFor,
    showFirstFieldToFix,
    saving: saveMutation.isPending,
    save,
    refreshRecord,
  };
}
