import { useEffect, useMemo, useState } from 'react';
import { Banner, Button, Checkbox, Field, Input, Select, Sheet, useToast } from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n } from '../../../../hooks/useI18n';
import { transferTargets, type Actor, type TargetMember } from '../../../../lib/authority';

/**
 * TransferStoreSheet (D2, 2026-05-06).
 *
 * Wizard for atomically moving a member from one store to another.
 * The wizard is one screen, not multi-step:
 *   - source store name shown read-only at top
 *   - destination store: dropdown of the actor's other admin stores
 *     (filtered by `session.adminStoreIds`, exclude the source)
 *   - "Mirror role bindings" toggle (default ON) — copies every store-
 *     scoped role binding the member has in `from` to `to`. Off means
 *     the operator wants a clean break (e.g. promotion to a different
 *     role at the new location).
 *   - footer button calls memberTransferStore in one tx
 *
 * Server enforces C1 in BOTH stores and C2 (admin of both); the FE
 * filtering is just UX.
 */
export function TransferStoreSheet({
  actor,
  target,
  onClose,
}: {
  actor: Actor;
  target: {
    memberId: string;
    displayName: string;
    fromStoreId: string;
    fromStoreName: string;
    member: TargetMember;
  } | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const session = useAuthStore((s) => s.session);
  const sessionStores = useMemo(() => session?.stores ?? [], [session?.stores]);
  const open = !!target;

  const [toStoreId, setToStoreId] = useState<string>('');
  const [mirrorRoles, setMirrorRoles] = useState(true);

  useEffect(() => {
    // Reset the form whenever the sheet is opened with a new target.
    if (target) {
      setToStoreId('');
      setMirrorRoles(true);
    }
  }, [target]);

  // Eligible destinations: stores actor admins, excluding the source
  // and (rare) inactive stores that may sneak into session.stores.
  // CMP-ADM-1 / ADM-18: only stores the server would accept — and not
  // one the member is already in.
  const destinationStores = useMemo(() => {
    if (!target) return [];
    return transferTargets(actor, target.member, target.fromStoreId, sessionStores);
  }, [sessionStores, actor, target]);

  const transferMut = trpc.admin.memberTransferStore.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      void utils.admin.memberStoreAssignments.invalidate();
      const parts = [i18n.t('people.toastTransferred')];
      if (data.mirrored > 0) parts.push(i18n.t('people.toastRolesMirrored', { n: data.mirrored }));
      if (data.revokedBindings > 0)
        parts.push(i18n.t('people.toastFromSideRevoked', { n: data.revokedBindings }));
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: errToast('common.errors.actionFailed'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !transferMut.isPending && onClose()}
      title={i18n.t('people.transferTitle')}
      description={target ? i18n.t('people.transferMoving', { name: target.displayName }) : ''}
      footer={
        target ? (
          <Button
            block
            size="lg"
            loading={transferMut.isPending}
            disabled={!toStoreId}
            // UX-05: with no store to move to, the banner above says why.
            disabledHint={destinationStores.length > 0 ? i18n.t('people.transferPickStore') : ''}
            onClick={() =>
              transferMut.mutate({
                memberId: target.memberId,
                fromStoreId: target.fromStoreId,
                toStoreId,
                mirrorRoles,
              })
            }
          >
            {i18n.t('people.transferAction')}
          </Button>
        ) : undefined
      }
    >
      {target ? (
        <div className="flex flex-col gap-3 py-3">
          {/* UI-01: the store they leave, in a read-only field, so that the
              label names it. It was a box drawn to look like a field. Out
              of the tab order like that box: the sheet still opens on the
              store to move to, not on this text, selected. */}
          <Field label={i18n.t('people.transferFrom')}>
            <Input value={target.fromStoreName} readOnly tabIndex={-1} />
          </Field>
          <Field label={i18n.t('people.transferTo')} required>
            {destinationStores.length === 0 ? (
              <Banner tone="warn" title={i18n.t('people.transferNoDestTitle')}>
                {i18n.t('people.transferNoDestBody')}
              </Banner>
            ) : (
              <Select value={toStoreId} onChange={(e) => setToStoreId(e.target.value)}>
                <option value="">{i18n.t('people.pickDestinationStore')}</option>
                {destinationStores.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {/* As in the clone sheet (ADM2-12 / ADM2-33): the kit checkbox,
              not a native box with a <div> inside its <label>. */}
          <Checkbox
            checked={mirrorRoles}
            onChange={(e) => setMirrorRoles(e.target.checked)}
            label={i18n.t('people.mirrorRoles')}
            hint={i18n.t('people.mirrorRolesHint', { store: target.fromStoreName })}
          />
          {/* ADM-23: without mirrored roles the member arrives with no
              permissions at all; say so in warning colours. */}
          <Banner tone={mirrorRoles ? 'info' : 'warn'} title={i18n.t('people.transferWhatTitle')}>
            {i18n.t('people.transferWhatIntro')}
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-old-label">
              <li>{i18n.t('people.transferWhatAdded', { name: target.displayName })}</li>
              <li>
                {i18n.t(mirrorRoles ? 'people.transferWhatMirrored' : 'people.transferWhatNoRoles')}
              </li>
              <li>{i18n.t('people.transferWhatRemoved', { store: target.fromStoreName })}</li>
            </ul>
            {i18n.t('people.transferWhatOutro')}
          </Banner>
        </div>
      ) : null}
    </Sheet>
  );
}
